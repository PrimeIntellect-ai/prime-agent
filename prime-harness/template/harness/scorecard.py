#!/usr/bin/env python3
"""Generate a durable Prime Harness telemetry scorecard outside the agent kernel.

The script is deliberately stdlib-only.  It reads durable artifacts but never
imports Prime Agent or a harness skill, never writes the evidence ledger, and
never emits prompt/tool/message content.

Usage:
  python harness/scorecard.py [--repo PATH] [--session-file PATH]
      [--session-dir PATH] [--output PATH] [--markdown PATH]
      [--now ISO8601] [--fail-on never|warning|critical]
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import html
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1
MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024
FUTURE_EVENT_SKEW_SECONDS = 10.0
USAGE_FIELDS = ("input", "output", "cacheRead", "cacheWrite", "totalTokens")
COST_FIELDS = ("input", "output", "cacheRead", "cacheWrite", "total")
CODE_SUFFIXES = {
    ".c", ".cc", ".cpp", ".cs", ".ex", ".exs", ".fs", ".fsx", ".go",
    ".h", ".hpp", ".hrl", ".java", ".jl", ".js", ".jsx", ".kt", ".kts",
    ".lean", ".lua", ".m", ".mm", ".php", ".ps1", ".py", ".r", ".rb",
    ".rs", ".scala", ".sh", ".swift", ".ts", ".tsx",
}
DEAD_STATUSES = {"dead", "error", "failed", "killed", "timed_out", "timeout"}
RUNNING_STATUSES = {"running", "active", "spawned"}
SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2}
DEFAULT_COVERAGE_POLICY = {
    "min_evidence_per_100_lines": 1.0,
    "churn_alert_min_lines": 100,
    "exempt_globs": ["docs/**", "generated/**"],
}
MAX_COVERAGE_GLOBS = 128
MAX_COVERAGE_GLOB_CHARS = 256
MAX_CONFIG_BYTES = 1024 * 1024
WINDOWS_REPARSE_ATTRIBUTE = 0x400


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time(value: Any) -> datetime | None:
    try:
        if isinstance(value, bool) or value is None:
            return None
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            seconds = float(value) / 1000.0 if abs(float(value)) > 10_000_000_000 else float(value)
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        if not isinstance(value, str) or not value.strip():
            return None
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (ValueError, OSError, OverflowError):
        return None


def short_path(path: Path | None, root: Path) -> str | None:
    if path is None:
        return None
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except (OSError, ValueError):
        return path.name


def read_json(path: Path, warnings: list[str], label: str) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        warnings.append(f"{label}:missing")
        return None
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        warnings.append(f"{label}:unreadable:{type(exc).__name__}")
        return None
    if not isinstance(value, dict):
        warnings.append(f"{label}:not_object")
        return None
    return value


def _stable_bounded_config(path: Path) -> bytes | None:
    try:
        before = path.stat(follow_symlinks=False)
        if path.is_symlink() or bool(getattr(before, "st_file_attributes", 0) & WINDOWS_REPARSE_ATTRIBUTE):
            return None
        if not path.is_file() or before.st_size > MAX_CONFIG_BYTES:
            return None
        with path.open("rb") as handle:
            value = handle.read(MAX_CONFIG_BYTES + 1)
        after = path.stat(follow_symlinks=False)
    except OSError:
        return None
    if len(value) > MAX_CONFIG_BYTES:
        return None
    identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns)
    return value if identity(before) == identity(after) else None


def load_harness_config(root: Path) -> dict[str, Any]:
    path = root / "harness" / "config.json"
    try:
        if os.path.lexists(path):
            raw = _stable_bounded_config(path)
            if raw is None:
                raise ValueError("harness/config.json is not a stable bounded regular file")
            document = json.loads(raw.decode("utf-8"))
        else:
            document = {}
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("harness/config.json is not readable strict UTF-8 JSON") from exc
    if not isinstance(document, dict):
        raise ValueError("harness/config.json must be an object")
    return document


def load_coverage_policy(root: Path, document: dict[str, Any] | None = None) -> dict[str, Any]:
    document = load_harness_config(root) if document is None else document
    raw = document.get("verification_coverage", {})
    if not isinstance(raw, dict):
        raise ValueError("verification_coverage must be an object")
    allowed = set(DEFAULT_COVERAGE_POLICY)
    unknown = set(raw) - allowed
    if unknown:
        raise ValueError(f"verification_coverage has unknown keys: {sorted(unknown)}")
    threshold = raw.get("min_evidence_per_100_lines", DEFAULT_COVERAGE_POLICY["min_evidence_per_100_lines"])
    minimum = raw.get("churn_alert_min_lines", DEFAULT_COVERAGE_POLICY["churn_alert_min_lines"])
    globs = raw.get("exempt_globs", DEFAULT_COVERAGE_POLICY["exempt_globs"])
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(float(threshold)) or float(threshold) < float(DEFAULT_COVERAGE_POLICY["min_evidence_per_100_lines"]):
        raise ValueError("verification_coverage.min_evidence_per_100_lines cannot weaken the default")
    if isinstance(minimum, bool) or not isinstance(minimum, int) or not 0 <= minimum <= int(DEFAULT_COVERAGE_POLICY["churn_alert_min_lines"]):
        raise ValueError("verification_coverage.churn_alert_min_lines cannot weaken the default")
    if not isinstance(globs, list) or len(globs) > MAX_COVERAGE_GLOBS:
        raise ValueError(f"verification_coverage.exempt_globs must be a list of at most {MAX_COVERAGE_GLOBS} strings")
    normalized: list[str] = []
    for pattern in globs:
        if (
            not isinstance(pattern, str) or not pattern or len(pattern) > MAX_COVERAGE_GLOB_CHARS
            or "\0" in pattern or "\\" in pattern or pattern.startswith("/")
            or re.fullmatch(r"[A-Za-z0-9._-]+/\*\*", pattern) is None
        ):
            raise ValueError("verification_coverage.exempt_globs must contain only bounded top-level directory/** patterns")
        if pattern not in DEFAULT_COVERAGE_POLICY["exempt_globs"]:
            raise ValueError("verification_coverage.exempt_globs cannot expand the default exemption set")
        normalized.append(pattern)
    return {
        "min_evidence_per_100_lines": float(threshold),
        "churn_alert_min_lines": minimum,
        "exempt_globs": normalized,
    }


def _coverage_directory(relative: str) -> str:
    normalized = relative.replace("\\", "/").strip("/")
    return normalized.split("/", 1)[0] if "/" in normalized else "."


def _coverage_exempt(relative: str, patterns: list[str] | tuple[str, ...]) -> bool:
    return any(fnmatch.fnmatchcase(relative, pattern) for pattern in patterns)


def _parse_coverage_metadata(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, str) and len(raw) > 1024 * 1024:
        return None
    try:
        assumptions = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        return None
    if not isinstance(assumptions, dict) or "verification_coverage" not in assumptions:
        return {}
    coverage = assumptions["verification_coverage"]
    if not isinstance(coverage, dict) or set(coverage) - {"kind", "directories", "base_commit", "reason"}:
        return None
    kind = coverage.get("kind")
    directories = coverage.get("directories")
    base_commit = coverage.get("base_commit")
    reason = coverage.get("reason")
    if kind not in {"verification", "disposition"} or not isinstance(directories, list) or not directories or len(directories) > 128:
        return None
    if not isinstance(base_commit, str) or re.fullmatch(r"[0-9a-fA-F]{40,64}", base_commit) is None:
        return None
    normalized: list[str] = []
    for directory in directories:
        if (
            not isinstance(directory, str) or not directory or len(directory) > 128
            or directory not in {"."} and re.fullmatch(r"[A-Za-z0-9._-]+", directory) is None
        ):
            return None
        if directory not in normalized:
            normalized.append(directory)
    if kind == "disposition" and (not isinstance(reason, str) or len(reason.strip()) < 20):
        return None
    if kind == "verification" and reason is not None:
        return None
    return {"kind": kind, "directories": normalized, "base_commit": base_commit.lower(), "reason": reason.strip() if isinstance(reason, str) else None}


def iter_jsonl(path: Path, warnings: list[str], label: str) -> Iterable[dict[str, Any]]:
    try:
        handle = path.open("rb")
    except OSError as exc:
        warnings.append(f"{label}:unreadable:{type(exc).__name__}")
        return
    with handle:
        for number, raw in enumerate(handle, 1):
            if len(raw) > MAX_JSONL_LINE_BYTES:
                warnings.append(f"{label}:line_{number}:too_large")
                continue
            try:
                value = json.loads(raw.decode("utf-8-sig"))
            except (UnicodeError, json.JSONDecodeError) as exc:
                warnings.append(f"{label}:line_{number}:invalid:{type(exc).__name__}")
                continue
            if isinstance(value, dict):
                yield value
            else:
                warnings.append(f"{label}:line_{number}:not_object")


def empty_usage() -> dict[str, Any]:
    return {**{field: 0 for field in USAGE_FIELDS}, "cost": {field: Decimal(0) for field in COST_FIELDS}}


def _integer(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(float(value)) or float(value) < 0 or not float(value).is_integer():
        return None
    return int(value)


def _decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        return None
    if not number.is_finite() or number < 0:
        return None
    return number


def add_usage(total: dict[str, Any], raw: Any, warnings: list[str], label: str) -> None:
    if not isinstance(raw, dict):
        warnings.append(f"{label}:usage_not_object")
        return
    for field in USAGE_FIELDS:
        if field not in raw:
            continue
        value = _integer(raw[field])
        if value is None:
            warnings.append(f"{label}:invalid_{field}")
        else:
            total[field] += value
    cost = raw.get("cost")
    if cost is None:
        return
    if not isinstance(cost, dict):
        warnings.append(f"{label}:cost_not_object")
        return
    for field in COST_FIELDS:
        if field not in cost:
            continue
        value = _decimal(cost[field])
        if value is None:
            warnings.append(f"{label}:invalid_cost_{field}")
        else:
            total["cost"][field] += value


def public_usage(total: dict[str, Any]) -> dict[str, Any]:
    return {
        **{field: int(total[field]) for field in USAGE_FIELDS},
        "cost": {field: round(float(total["cost"][field]), 12) for field in COST_FIELDS},
    }


def code_hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8", errors="surrogatepass")).hexdigest()


def scan_session(
    path: Path | None,
    start: datetime | None,
    end: datetime,
    warnings: list[str],
    future_skew_seconds: float = FUTURE_EVENT_SKEW_SECONDS,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "present": bool(path and path.is_file()),
        "parent_usage": empty_usage(),
        "child_groups": defaultdict(lambda: {"usage": empty_usage(), "event_count": 0, "event_ids": [], "origins": Counter()}),
        "target_code_hashes": defaultdict(set),
        "goal": None,
        "entries_seen": 0,
        "child_usage_events": 0,
        "duplicate_child_usage_events": 0,
    }
    if path is None or not path.is_file():
        warnings.append("session:missing")
        return result
    seen_usage_ids: set[str] = set()
    effective_end = end + timedelta(seconds=future_skew_seconds)
    for entry in iter_jsonl(path, warnings, "session"):
        result["entries_seen"] += 1
        timestamp = parse_time(entry.get("timestamp"))
        if timestamp is not None and timestamp > effective_end:
            warnings.append("session:future_entry")
        in_window = timestamp is None or (
            (start is None or timestamp >= start) and timestamp <= effective_end
        )
        entry_type = entry.get("type")
        if entry_type == "message":
            message = entry.get("message")
            if not isinstance(message, dict):
                continue
            entry_id = entry.get("id")
            if in_window and isinstance(entry_id, str):
                content = message.get("content")
                if isinstance(content, list):
                    for part in content:
                        if not isinstance(part, dict) or part.get("type") != "toolCall":
                            continue
                        arguments = part.get("arguments")
                        if isinstance(arguments, dict) and isinstance(arguments.get("code"), str):
                            result["target_code_hashes"][entry_id].add(code_hash(arguments["code"]))
            if in_window and message.get("role") == "assistant" and isinstance(message.get("usage"), dict):
                add_usage(result["parent_usage"], message["usage"], warnings, "session:parent")
        elif entry_type == "child_usage_attributed" and in_window:
            event_id = entry.get("id")
            if isinstance(event_id, str) and event_id:
                if event_id in seen_usage_ids:
                    result["duplicate_child_usage_events"] += 1
                    continue
                seen_usage_ids.add(event_id)
            else:
                warnings.append("session:child_usage_missing_id")
            target = entry.get("targetId")
            target = target if isinstance(target, str) and target else "<missing-target>"
            group = result["child_groups"][target]
            add_usage(group["usage"], entry.get("childUsage"), warnings, "session:child")
            group["event_count"] += 1
            if isinstance(event_id, str):
                group["event_ids"].append(event_id)
            origin = entry.get("origin")
            if isinstance(origin, str):
                group["origins"][origin] += 1
            result["child_usage_events"] += 1
        elif in_window and entry_type == "custom" and entry.get("customType") == "thread_goal_state":
            data = entry.get("data")
            if isinstance(data, dict):
                result["goal"] = data
    return result


def scan_registry(
    path: Path | None,
    start: datetime | None,
    now: datetime,
    stale_minutes: float,
    warnings: list[str],
    future_skew_seconds: float = FUTURE_EVENT_SKEW_SECONDS,
) -> dict[str, Any]:
    latest: dict[str, dict[str, Any]] = {}
    effective_now = now + timedelta(seconds=future_skew_seconds)
    if path is None or not path.is_file():
        warnings.append("registry:missing")
    else:
        for entry in iter_jsonl(path, warnings, "registry"):
            child_id = entry.get("childId")
            entry_time = parse_time(entry.get("updatedAt")) or parse_time(entry.get("createdAt"))
            if entry_time is not None and entry_time > effective_now:
                warnings.append("registry:future_entry")
                continue
            if isinstance(child_id, str) and child_id:
                latest[child_id] = entry
            else:
                warnings.append("registry:missing_child_id")
    children: list[dict[str, Any]] = []
    spawn_hash_map: dict[str, set[str]] = defaultdict(set)
    for child_id, entry in latest.items():
        created = parse_time(entry.get("createdAt"))
        if start is not None and created is not None and created < start:
            continue
        updated = parse_time(entry.get("updatedAt")) or created
        session_value = entry.get("sessionFile")
        session_file = Path(session_value) if isinstance(session_value, str) and session_value else None
        session_present = bool(session_file and session_file.is_file())
        activity = updated
        if session_present and session_file is not None:
            latest_event = None
            for session_entry in iter_jsonl(session_file, warnings, "child_session"):
                event_time = parse_time(session_entry.get("timestamp"))
                if event_time is not None and event_time <= now and (latest_event is None or event_time > latest_event):
                    latest_event = event_time
            if latest_event is not None:
                activity = max(x for x in (activity, latest_event) if x is not None)
        status = entry.get("status") if isinstance(entry.get("status"), str) else "unknown"
        age_minutes = None
        if activity is not None:
            age_minutes = max(0.0, (now - activity).total_seconds() / 60.0)
        stale = status.lower() in RUNNING_STATUSES and age_minutes is not None and age_minutes >= stale_minutes
        dead = status.lower() in DEAD_STATUSES
        spawn_code = entry.get("spawnCode")
        spawn_digest = code_hash(spawn_code) if isinstance(spawn_code, str) else None
        if spawn_digest:
            spawn_hash_map[spawn_digest].add(child_id)
        model_value = entry.get("model")
        if isinstance(model_value, dict):
            provider = model_value.get("provider")
            model_id = model_value.get("modelId") or model_value.get("id")
            model = f"{provider}/{model_id}" if isinstance(provider, str) and isinstance(model_id, str) else None
        else:
            model = model_value if isinstance(model_value, str) else None
        children.append({
            "child_id": child_id,
            "name": entry.get("sessionName") if isinstance(entry.get("sessionName"), str) else child_id,
            "status": status,
            "model": model,
            "created_at": iso_utc(created) if created else None,
            "updated_at": iso_utc(updated) if updated else None,
            "last_activity_at": iso_utc(activity) if activity else None,
            "age_minutes": round(age_minutes, 3) if age_minutes is not None else None,
            "possibly_stale": stale,
            "dead": dead,
            "session_file_present": session_present,
            "spawn_digest": spawn_digest,
        })
    children.sort(key=lambda item: (item["created_at"] or "", item["child_id"]))
    return {"children": children, "spawn_hash_map": spawn_hash_map}


RESULT_STATUSES = {"pass", "fail", "counterexample_found", "inconclusive", "done", "error"}


def confined_result_path(raw: Any, artifact_root: Path) -> Path | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    if raw.startswith(("\\\\", "\\\\?\\", "\\\\.\\")):
        return None
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = artifact_root / candidate
    try:
        resolved_root = artifact_root.resolve()
        resolved = candidate.resolve(strict=False)
        resolved.relative_to(resolved_root)
        return resolved
    except (OSError, ValueError):
        return None


def scan_children_state(
    path: Path,
    artifact_root: Path,
    start: datetime | None,
    end: datetime,
    warnings: list[str],
    future_skew_seconds: float = FUTURE_EVENT_SKEW_SECONDS,
) -> dict[str, Any]:
    data = read_json(path, warnings, "children_state") if path.is_file() else None
    records: dict[str, dict[str, Any]] = {}
    if data is None:
        return {"present": path.is_file(), "records": records}
    effective_end = end + timedelta(seconds=future_skew_seconds)
    for name, entry in data.items():
        if not isinstance(name, str) or not isinstance(entry, dict):
            warnings.append("children_state:invalid_entry")
            continue
        spawned = parse_time(entry.get("spawned_at")) or parse_time(entry.get("reserved_at"))
        if spawned is not None and (
            (start is not None and spawned < start) or spawned > effective_end
        ):
            if spawned > effective_end:
                warnings.append("children_state:future_entry")
            continue
        raw_result_path = entry.get("result_path")
        result_path = confined_result_path(raw_result_path, artifact_root)
        contract_state = "missing"
        result_status = None
        if raw_result_path and result_path is None:
            contract_state = "outside_artifact_root"
            warnings.append("children_state:result_path_rejected")
        elif result_path is not None and result_path.is_file():
            result = read_json(result_path, warnings, "child_result")
            candidate_status = result.get("status") if result else None
            if isinstance(candidate_status, str) and candidate_status in RESULT_STATUSES:
                contract_state = "valid"
                result_status = candidate_status
            else:
                contract_state = "invalid"
                warnings.append("children_state:invalid_result_contract")
        records[name] = {
            "orchestrator_status": entry.get("status") if isinstance(entry.get("status"), str) else "unknown",
            "spawned_at": iso_utc(spawned) if spawned else None,
            "result_contract": contract_state,
            "result_status": result_status,
        }
    return {"present": True, "records": records}


def enrich_child_lifecycle(child_rows: list[dict[str, Any]], children_state: dict[str, Any]) -> list[dict[str, Any]]:
    controls = children_state["records"]
    by_name = {child["name"]: child for child in child_rows}
    for child in child_rows:
        control = controls.get(child["name"])
        child["orchestrator_status"] = control["orchestrator_status"] if control else None
        child["result_contract"] = control["result_contract"] if control else "not_required"
        child["result_status"] = control["result_status"] if control else None
        reported = bool(control and control["result_contract"] == "valid")
        terminal_without_result = bool(
            control
            and control["result_contract"] != "valid"
            and child["status"].lower() in {"completed", "deleted"}
        )
        child["reported"] = reported
        child["dead"] = bool(child["dead"] or terminal_without_result)
        if reported:
            child["possibly_stale"] = False
    for name, control in sorted(controls.items()):
        if name in by_name:
            continue
        reported = control["result_contract"] == "valid"
        usage = public_usage(empty_usage())
        child_rows.append({
            "child_id": None,
            "name": name,
            "status": "absent",
            "model": None,
            "created_at": control["spawned_at"],
            "updated_at": None,
            "last_activity_at": None,
            "age_minutes": None,
            "possibly_stale": False,
            "dead": not reported,
            "session_file_present": False,
            "attribution": {"mapped": False, "target_ids": [], "event_count": 0},
            "usage": usage,
            "orchestrator_status": control["orchestrator_status"],
            "result_contract": control["result_contract"],
            "result_status": control["result_status"],
            "reported": reported,
        })
    child_rows.sort(key=lambda item: (item["created_at"] or "", item["name"]))
    return child_rows


def attribute_child_usage(session: dict[str, Any], registry: dict[str, Any], warnings: list[str]) -> dict[str, Any]:
    children = registry["children"]
    by_id = {child["child_id"]: child for child in children}
    assigned_targets: dict[str, list[str]] = defaultdict(list)
    unattributed: list[dict[str, Any]] = []
    ambiguous: list[dict[str, Any]] = []
    for target, group in sorted(session["child_groups"].items()):
        candidates: set[str] = set()
        for digest in session["target_code_hashes"].get(target, set()):
            candidates.update(registry["spawn_hash_map"].get(digest, set()))
        public = {
            "target_id": target,
            "event_count": group["event_count"],
            "origins": dict(sorted(group["origins"].items())),
            "usage": public_usage(group["usage"]),
        }
        if len(candidates) == 1:
            assigned_targets[next(iter(candidates))].append(target)
        elif len(candidates) > 1:
            public["candidate_count"] = len(candidates)
            ambiguous.append(public)
        else:
            unattributed.append(public)
    total = empty_usage()
    child_rows: list[dict[str, Any]] = []
    for child in children:
        usage = empty_usage()
        target_ids = sorted(assigned_targets.get(child["child_id"], []))
        event_count = 0
        for target in target_ids:
            group = session["child_groups"][target]
            add_usage(usage, public_usage(group["usage"]), warnings, "attribution:internal")
            event_count += int(group["event_count"])
        add_usage(total, public_usage(usage), warnings, "attribution:total")
        row = {key: value for key, value in child.items() if key != "spawn_digest"}
        row["attribution"] = {"mapped": bool(target_ids), "target_ids": target_ids, "event_count": event_count}
        row["usage"] = public_usage(usage)
        child_rows.append(row)
    return {
        "children": child_rows,
        "totals": public_usage(total),
        "unattributed": unattributed,
        "ambiguous": ambiguous,
        "event_count": session["child_usage_events"],
        "duplicate_event_count": session["duplicate_child_usage_events"],
    }


def gate_timestamp(path: Path) -> datetime | None:
    match = re.match(r"^(\d{8}T\d{6}Z)(?:-|$)", path.parent.name)
    if match:
        try:
            return datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    except OSError:
        return None


def scan_gates(gate_root: Path, start: datetime | None, end: datetime,
               warnings: list[str]) -> dict[str, Any]:
    runs: list[dict[str, Any]] = []
    incomplete_archives = 0
    if not gate_root.is_dir():
        warnings.append("gates:missing")
    else:
        for directory in sorted(path for path in gate_root.iterdir() if path.is_dir()):
            result_path = directory / "gate-result.json"
            timestamp = gate_timestamp(result_path)
            in_window = timestamp is None or ((start is None or timestamp >= start) and timestamp <= end)
            if in_window and not result_path.is_file():
                incomplete_archives += 1
                warnings.append("gates:incomplete_archive")
        for path in sorted(gate_root.glob("*/gate-result.json")):
            timestamp = gate_timestamp(path)
            if timestamp is not None and ((start is not None and timestamp < start) or timestamp > end):
                if timestamp > end:
                    warnings.append("gates:future_result")
                continue
            data = read_json(path, warnings, f"gate:{path.parent.name}")
            if data is None:
                continue
            raw_results = data.get("results")
            incomplete = not isinstance(raw_results, list)
            results = raw_results if isinstance(raw_results, list) else []
            check_counts = Counter()
            for result in results:
                if not isinstance(result, dict):
                    check_counts["unknown"] += 1
                    incomplete = True
                    continue
                status = result.get("status")
                check_counts[status if isinstance(status, str) else "unknown"] += 1
                if not isinstance(status, str):
                    incomplete = True
            applicable = sum(value for key, value in check_counts.items() if key != "skipped")
            status = data.get("status") if isinstance(data.get("status"), str) else "unknown"
            profile = data.get("profile") if isinstance(data.get("profile"), str) else "<unknown>"
            if status not in {"pass", "fail", "error"}:
                incomplete = True
            for summary_key in ("passed", "failed", "skipped"):
                if summary_key in data and not isinstance(data[summary_key], list):
                    incomplete = True
            runs.append({
                "run_id": path.parent.name,
                "timestamp": iso_utc(timestamp) if timestamp else None,
                "profile": profile,
                "status": status,
                "vacuous": status == "pass" and applicable == 0,
                "incomplete": incomplete,
                "applicable_checks": applicable,
                "check_counts": dict(sorted(check_counts.items())),
            })
    runs.sort(key=lambda item: (item["timestamp"] or "", item["run_id"]))
    status_counts = Counter(run["status"] for run in runs)
    passed_runs = status_counts.get("pass", 0)
    check_counts = Counter()
    profile_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for run in runs:
        check_counts.update(run["check_counts"])
        profile_groups[run["profile"]].append(run)
    applicable = sum(value for key, value in check_counts.items() if key != "skipped")
    passed_checks = check_counts.get("pass", 0)
    substantive = [run for run in runs if run["applicable_checks"] > 0 or run["status"] in {"fail", "error"}]
    substantive_passed = sum(1 for run in substantive if run["status"] == "pass")
    profiles: dict[str, Any] = {}
    unrecovered_profiles: list[str] = []
    for profile, profile_runs in sorted(profile_groups.items()):
        profile_substantive = [run for run in profile_runs if run["applicable_checks"] > 0 or run["status"] in {"fail", "error"}]
        latest_substantive = profile_substantive[-1] if profile_substantive else None
        unrecovered = bool(latest_substantive and latest_substantive["status"] != "pass")
        if unrecovered:
            unrecovered_profiles.append(profile)
        profiles[profile] = {
            "runs_total": len(profile_runs),
            "pass_rate": round(sum(1 for run in profile_runs if run["status"] == "pass") / len(profile_runs), 6),
            "substantive_runs": len(profile_substantive),
            "substantive_pass_rate": round(sum(1 for run in profile_substantive if run["status"] == "pass") / len(profile_substantive), 6) if profile_substantive else None,
            "vacuous_passes": sum(1 for run in profile_runs if run["vacuous"]),
            "latest": profile_runs[-1],
            "latest_substantive": latest_substantive,
            "unrecovered_failure": unrecovered,
        }
    return {
        "runs_total": len(runs),
        "archived_runs_total": len(runs),
        "status_counts": dict(sorted(status_counts.items())),
        "pass_rate": round(passed_runs / len(runs), 6) if runs else None,
        "archived_pass_rate": round(passed_runs / len(runs), 6) if runs else None,
        "substantive_runs": len(substantive),
        "substantive_pass_rate": round(substantive_passed / len(substantive), 6) if substantive else None,
        "vacuous_passes": sum(1 for run in runs if run["vacuous"]),
        "incomplete_runs": sum(1 for run in runs if run["incomplete"]),
        "incomplete_archives": incomplete_archives,
        "unrecovered_profiles": unrecovered_profiles,
        "profiles": profiles,
        "applicable_checks": applicable,
        "check_counts": dict(sorted(check_counts.items())),
        "check_pass_rate": round(passed_checks / applicable, 6) if applicable else None,
        "latest": runs[-1] if runs else None,
        "runs": runs,
    }

def scan_evidence(path: Path, start: datetime | None, end: datetime,
                  task_evidence_ids: list[str], warnings: list[str]) -> dict[str, Any]:
    result = {
        "database_present": path.is_file(),
        "task_evidence_ids": len(task_evidence_ids),
        "matched_task_evidence_ids": 0,
        "missing_task_evidence_ids": 0,
        "outside_task_records": 0,
        "records_total": 0,
        "status_counts": {},
        "activity_records": 0,
        "records_with_verifier": 0,
        "verified_without_verifier": 0,
        "coverage_schema_available": False,
        "_coverage_records": [],
    }
    if not path.is_file():
        warnings.append("evidence:missing")
        result["missing_task_evidence_ids"] = len(task_evidence_ids)
        return result
    connection: sqlite3.Connection | None = None
    try:
        uri = path.resolve().as_uri() + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=5)
        connection.execute("PRAGMA query_only=ON")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(evidence)")}
        required = {"id", "status", "verifier", "created_at"}
        if not required.issubset(columns):
            warnings.append("evidence:schema_missing_columns")
            result["missing_task_evidence_ids"] = len(task_evidence_ids)
            return result
        coverage_columns = {"claim_type", "assumptions", "commit_sha", "invalidated_at"}
        coverage_schema = coverage_columns.issubset(columns)
        result["coverage_schema_available"] = coverage_schema
        selected_columns = ["id", "status", "verifier", "created_at"]
        if coverage_schema:
            selected_columns.extend(["claim_type", "assumptions", "commit_sha", "invalidated_at"])
        rows = connection.execute(
            f"SELECT {', '.join(selected_columns)} FROM evidence ORDER BY rowid LIMIT 100001"
        ).fetchall()
        if len(rows) > 100000:
            warnings.append("evidence:row_limit_exceeded")
            rows = rows[:100000]
    except sqlite3.Error as exc:
        warnings.append(f"evidence:unreadable:{type(exc).__name__}")
        result["missing_task_evidence_ids"] = len(task_evidence_ids)
        return result
    finally:
        if connection is not None:
            connection.close()
    wanted = set(task_evidence_ids)
    matched: set[str] = set()
    outside = 0
    selected: list[tuple[Any, ...]] = []
    for row in rows:
        evidence_id, status, verifier, created_at = row[:4]
        created = parse_time(created_at)
        if created is not None and created > end:
            warnings.append("evidence:future_record")
            continue
        in_window = start is None or created is None or created >= start
        if isinstance(evidence_id, str) and evidence_id in wanted:
            matched.add(evidence_id)
            selected.append(row)
        elif in_window:
            outside += 1
    statuses = Counter()
    activity = 0
    with_verifier = 0
    verified_without = 0
    coverage_records: list[dict[str, Any]] = []
    for row in selected:
        evidence_id, status, verifier, created_at = row[:4]
        status_text = status if isinstance(status, str) else "unknown"
        statuses[status_text] += 1
        has_verifier = isinstance(verifier, str) and bool(verifier.strip())
        if has_verifier:
            with_verifier += 1
        if status_text == "verified" and not has_verifier:
            verified_without += 1
        if status_text in {"verified", "refuted", "inconclusive"}:
            activity += 1
        if result["coverage_schema_available"]:
            claim_type, assumptions, commit_sha, invalidated_at = row[4:8]
            metadata = _parse_coverage_metadata(assumptions)
            if metadata is None:
                warnings.append(f"evidence:invalid_coverage_metadata:{evidence_id}")
                metadata = {}
            coverage_records.append({
                "id": evidence_id,
                "status": status_text,
                "has_verifier": has_verifier,
                "claim_type": claim_type if isinstance(claim_type, str) else None,
                "commit_sha": commit_sha if isinstance(commit_sha, str) else None,
                "invalidated": invalidated_at is not None,
                "coverage": metadata,
            })
    result.update({
        "matched_task_evidence_ids": len(matched),
        "missing_task_evidence_ids": len(wanted - matched),
        "outside_task_records": outside,
        "records_total": sum(statuses.values()),
        "status_counts": dict(sorted(statuses.items())),
        "activity_records": activity,
        "records_with_verifier": with_verifier,
        "verified_without_verifier": verified_without,
        "_coverage_records": coverage_records,
    })
    return result

def run_git(root: Path, argv: list[str], warnings: list[str], label: str) -> subprocess.CompletedProcess[bytes] | None:
    try:
        proc = subprocess.run(["git", *argv], cwd=root, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        warnings.append(f"git:{label}:{type(exc).__name__}")
        return None
    if proc.returncode != 0:
        warnings.append(f"git:{label}:exit_{proc.returncode}")
        return None
    return proc


def is_code_path(path: str) -> bool:
    candidate = Path(path)
    return candidate.suffix.lower() in CODE_SUFFIXES or candidate.name.lower() in {"dockerfile", "makefile"}


def count_file_lines(path: Path) -> tuple[int | None, bool]:
    try:
        if path.is_symlink() or not path.is_file():
            return None, True
        count = 0
        last = b""
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                if b"\0" in chunk:
                    return None, True
                count += chunk.count(b"\n")
                last = chunk[-1:]
        if last and last != b"\n":
            count += 1
        return count, False
    except OSError:
        return None, True


def _is_ancestor(root: Path, ancestor: str, descendant: str, warnings: list[str], label: str) -> bool | None:
    try:
        proc = subprocess.run(
            ["git", "merge-base", "--is-ancestor", ancestor, descendant],
            cwd=root, capture_output=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        warnings.append(f"git:{label}:{type(exc).__name__}")
        return None
    if proc.returncode == 0:
        return True
    if proc.returncode == 1:
        return False
    warnings.append(f"git:{label}:exit_{proc.returncode}")
    return None


def scan_churn(root: Path, base: str | None, warnings: list[str],
               exempt_globs: list[str] | tuple[str, ...] = (),
               binary_charge_lines: int = 100,
               highest_observed_head: str | None = None) -> dict[str, Any]:
    branch_proc = run_git(root, ["branch", "--show-current"], warnings, "branch")
    branch = branch_proc.stdout.decode("utf-8", errors="replace").strip() if branch_proc else None
    head_proc = run_git(root, ["rev-parse", "--verify", "HEAD"], warnings, "head")
    head = head_proc.stdout.decode("ascii", errors="replace").strip() if head_proc else None
    resolved_base = None
    base_ancestor_head: bool | None = None
    observed_head_resolved: str | None = None
    observed_head_ancestor: bool | None = None
    rows: list[tuple[int | None, int | None, str]] = []
    if base and not base.startswith("-"):
        resolved = run_git(root, ["rev-parse", "--verify", "--end-of-options", f"{base}^{{commit}}"], warnings, "base")
        if resolved:
            resolved_base = resolved.stdout.decode("ascii", errors="replace").strip()
    elif base:
        warnings.append("git:base:unsafe")
    else:
        warnings.append("git:base:missing")
    if resolved_base and head:
        base_ancestor_head = _is_ancestor(root, resolved_base, head, warnings, "base_ancestor_head")
    if isinstance(highest_observed_head, str) and re.fullmatch(r"[0-9a-fA-F]{40,64}", highest_observed_head):
        observed = run_git(root, ["rev-parse", "--verify", "--end-of-options", f"{highest_observed_head}^{{commit}}"], warnings, "observed_head")
        if observed and head:
            observed_head_resolved = observed.stdout.decode("ascii", errors="replace").strip()
            observed_head_ancestor = _is_ancestor(root, observed_head_resolved, head, warnings, "observed_head_ancestor")
    elif highest_observed_head is not None:
        warnings.append("git:observed_head:unsafe")
    if resolved_base and base_ancestor_head is True:
        diff = run_git(root, ["diff", "--numstat", "-z", "--no-renames", resolved_base, "--"], warnings, "diff")
        if diff:
            for raw in diff.stdout.split(b"\0"):
                if not raw:
                    continue
                parts = raw.split(b"\t", 2)
                if len(parts) != 3:
                    warnings.append("git:diff:malformed_numstat")
                    continue
                add_raw, delete_raw, path_raw = parts
                path_text = path_raw.decode("utf-8", errors="replace")
                added = int(add_raw) if add_raw.isdigit() else None
                deleted = int(delete_raw) if delete_raw.isdigit() else None
                rows.append((added, deleted, path_text))
    untracked: list[str] = []
    others = run_git(root, ["ls-files", "--others", "--exclude-standard", "-z"], warnings, "untracked")
    if others:
        untracked = [item.decode("utf-8", errors="replace") for item in others.stdout.split(b"\0") if item]
    for relative in untracked:
        line_count, binary = count_file_lines(root / relative)
        rows.append((None if binary else line_count, 0 if not binary else None, relative))
    total_added = total_deleted = code_added = code_deleted = binary_files = 0
    exempt_code_lines = 0
    changed_paths: set[str] = set()
    directory_lines: Counter[str] = Counter()
    directory_binary_files: Counter[str] = Counter()
    directory_files: defaultdict[str, set[str]] = defaultdict(set)
    exempt_paths: set[str] = set()
    for added, deleted, relative in rows:
        changed_paths.add(relative)
        if added is None or deleted is None:
            binary_files += 1
            if is_code_path(relative):
                if _coverage_exempt(relative, exempt_globs):
                    exempt_paths.add(relative)
                else:
                    directory = _coverage_directory(relative)
                    directory_binary_files[directory] += 1
                    directory_lines[directory] += max(binary_charge_lines, 1)
                    directory_files[directory].add(relative)
            continue
        total_added += added
        total_deleted += deleted
        if is_code_path(relative):
            changed = added + deleted
            code_added += added
            code_deleted += deleted
            if _coverage_exempt(relative, exempt_globs):
                exempt_code_lines += changed
                exempt_paths.add(relative)
            else:
                directory = _coverage_directory(relative)
                directory_lines[directory] += changed
                directory_files[directory].add(relative)
    return {
        "base": resolved_base or base,
        "base_resolved": resolved_base is not None,
        "base_ancestor_head": base_ancestor_head,
        "base_equals_head": bool(resolved_base and head and resolved_base == head),
        "highest_observed_head": observed_head_resolved or highest_observed_head,
        "highest_observed_head_ancestor": observed_head_ancestor,
        "head": head,
        "working_branch": branch,
        "files_changed": len(changed_paths),
        "untracked_files": len(untracked),
        "binary_files": binary_files,
        "lines_added": total_added,
        "lines_deleted": total_deleted,
        "lines_changed": total_added + total_deleted,
        "code_lines_added": code_added,
        "code_lines_deleted": code_deleted,
        "code_lines_changed": code_added + code_deleted,
        "coverage_code_lines_changed": sum(directory_lines.values()),
        "coverage_unmeasured_binary_files": sum(directory_binary_files.values()),
        "coverage_exempt_code_lines": exempt_code_lines,
        "coverage_exempt_files": len(exempt_paths),
        "coverage_directories": [
            {"directory": directory, "code_lines_changed": directory_lines[directory],
             "unmeasured_binary_files": directory_binary_files[directory],
             "files_changed": len(directory_files[directory])}
            for directory in sorted(set(directory_lines).union(directory_binary_files))
        ],
    }


def _commit_code_directories(root: Path, commit: str | None, base: str | None,
                             exempt_globs: list[str], warnings: list[str]) -> set[str]:
    if not isinstance(commit, str) or re.fullmatch(r"[0-9a-fA-F]{40,64}", commit) is None or not base:
        return set()
    resolved_commit = run_git(root, ["rev-parse", "--verify", "--end-of-options", f"{commit}^{{commit}}"], warnings, "evidence_commit")
    if not resolved_commit:
        return set()
    commit_sha = resolved_commit.stdout.decode("ascii", errors="replace").strip()
    if commit_sha == base:
        return set()
    for ancestor, descendant, label in ((base, commit_sha, "evidence_after_base"), (commit_sha, "HEAD", "evidence_before_head")):
        try:
            proc = subprocess.run(["git", "merge-base", "--is-ancestor", ancestor, descendant], cwd=root, capture_output=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired) as exc:
            warnings.append(f"git:{label}:{type(exc).__name__}")
            return set()
        if proc.returncode != 0:
            return set()
    changed = run_git(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-z", "-r", commit_sha, "--"], warnings, "evidence_diff")
    if not changed:
        return set()
    directories: set[str] = set()
    for raw in changed.stdout.split(b"\0"):
        if not raw:
            continue
        relative = raw.decode("utf-8", errors="replace")
        if is_code_path(relative) and not _coverage_exempt(relative, exempt_globs):
            directories.add(_coverage_directory(relative))
    return directories


def build_directory_coverage(*, root: Path, base: str | None, churn: dict[str, Any],
                             coverage_records: list[dict[str, Any]], schema_available: bool,
                             min_evidence_per_100_lines: float, churn_alert_min_lines: int,
                             exempt_globs: list[str], warnings: list[str]) -> dict[str, Any]:
    rows = {item["directory"]: item for item in churn["coverage_directories"]}
    verification_ids: defaultdict[str, set[str]] = defaultdict(set)
    disposition_ids: defaultdict[str, set[str]] = defaultdict(set)
    commit_cache: dict[str, set[str]] = {}
    resolved_base = churn.get("base") if isinstance(churn.get("base"), str) else base
    for record in coverage_records:
        evidence_id = record.get("id")
        if not isinstance(evidence_id, str) or record.get("invalidated") or not record.get("has_verifier"):
            continue
        status = record.get("status")
        coverage = record.get("coverage") if isinstance(record.get("coverage"), dict) else {}
        kind = coverage.get("kind")
        explicit_directories: set[str] = set()
        if kind:
            if coverage.get("base_commit") != resolved_base:
                warnings.append(f"evidence:coverage_base_mismatch:{evidence_id}")
            else:
                explicit_directories = set(coverage.get("directories", []))
        commit_sha = record.get("commit_sha")
        automatic: set[str] = set()
        if isinstance(commit_sha, str):
            if commit_sha not in commit_cache:
                commit_cache[commit_sha] = _commit_code_directories(root, commit_sha, resolved_base, exempt_globs, warnings)
            automatic = commit_cache[commit_sha]
        if record.get("claim_type") == "verification-coverage-disposition":
            if (
                kind == "disposition" and status == "verified" and explicit_directories
                and explicit_directories.intersection(automatic)
            ):
                for directory in explicit_directories.intersection(automatic).intersection(rows):
                    disposition_ids[directory].add(evidence_id)
            else:
                warnings.append(f"evidence:rejected_coverage_disposition:{evidence_id}")
            continue
        if status != "verified":
            continue
        if kind == "verification":
            automatic = automatic.intersection(explicit_directories)
        for directory in automatic.intersection(rows):
            verification_ids[directory].add(evidence_id)
    enforce = (
        churn["coverage_code_lines_changed"] >= churn_alert_min_lines
        or churn.get("coverage_unmeasured_binary_files", 0) > 0
    )
    directory_results: list[dict[str, Any]] = []
    for directory in sorted(rows):
        lines = rows[directory]["code_lines_changed"]
        binary_files = rows[directory].get("unmeasured_binary_files", 0)
        ids = sorted(verification_ids[directory])
        dispositions = sorted(disposition_ids[directory])
        denominator = max(lines, 1 if binary_files else 0)
        rate = len(ids) * 100.0 / denominator if denominator else 0.0
        if not enforce:
            status = "below-minimum"
        elif dispositions:
            status = "disposition"
        elif binary_files and not ids:
            status = "behind"
        elif rate >= min_evidence_per_100_lines:
            status = "pass"
        else:
            status = "behind"
        directory_results.append({
            "directory": directory,
            "code_lines_changed": lines,
            "unmeasured_binary_files": binary_files,
            "files_changed": rows[directory]["files_changed"],
            "verification_records": len(ids),
            "verification_evidence_ids": ids,
            "records_per_100_lines": round(rate, 6),
            "disposition_evidence_ids": dispositions,
            "status": status,
        })
    return {
        "available": schema_available,
        "policy": {
            "min_evidence_per_100_lines": min_evidence_per_100_lines,
            "churn_alert_min_lines": churn_alert_min_lines,
            "exempt_globs": exempt_globs,
        },
        "enforced": enforce,
        "directories": directory_results,
    }

def goal_summary(data: Any) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    budget = _integer(data.get("tokenBudget"))
    used = _integer(data.get("tokensUsed"))
    remaining = max(0, budget - used) if budget is not None and used is not None else None
    updated = parse_time(data.get("updatedAt"))
    return {
        "goal_id": data.get("goalId") if isinstance(data.get("goalId"), str) else None,
        "active": bool(data.get("active")),
        "status": data.get("status") if isinstance(data.get("status"), str) else None,
        "token_budget": budget,
        "tokens_used": used,
        "remaining_tokens": remaining,
        "budget_used_rate": round(used / budget, 6) if budget and used is not None else None,
        "time_used_seconds": _integer(data.get("timeUsedSeconds")),
        "continuations_used": _integer(data.get("continuationsUsed")),
        "updated_at": iso_utc(updated) if updated else None,
    }


def task_summary(data: dict[str, Any] | None) -> dict[str, Any]:
    if not data:
        return {
            "task_id": None, "created_at": None, "updated_at": None, "base_commit": None,
            "working_branch": None, "quality_gate_status": {}, "phases_passed": 0,
            "phases_total": 0, "phase_progress_rate": None, "unresolved_claims_count": 0,
            "active_child_names": [], "evidence_ids_count": 0, "highest_observed_head": None,
        }
    gates = data.get("quality_gate_status") if isinstance(data.get("quality_gate_status"), dict) else {}
    phases_total = len(gates)
    phases_passed = sum(1 for value in gates.values() if value == "pass")
    unresolved = data.get("unresolved_claims") if isinstance(data.get("unresolved_claims"), list) else []
    active = data.get("active_child_names") if isinstance(data.get("active_child_names"), list) else []
    evidence_ids = data.get("evidence_ids") if isinstance(data.get("evidence_ids"), list) else []
    assumptions = data.get("assumptions") if isinstance(data.get("assumptions"), dict) else {}
    return {
        "task_id": data.get("task_id") if isinstance(data.get("task_id"), str) else None,
        "evidence_ids_count": len([item for item in evidence_ids if isinstance(item, str)]),
        "created_at": data.get("created_at") if isinstance(data.get("created_at"), str) else None,
        "updated_at": data.get("updated_at") if isinstance(data.get("updated_at"), str) else None,
        "base_commit": data.get("base_commit") if isinstance(data.get("base_commit"), str) else None,
        "highest_observed_head": assumptions.get("highest_observed_head") if isinstance(assumptions.get("highest_observed_head"), str) else None,
        "working_branch": data.get("working_branch") if isinstance(data.get("working_branch"), str) else None,
        "quality_gate_status": gates,
        "phases_passed": phases_passed,
        "phases_total": phases_total,
        "phase_progress_rate": round(phases_passed / phases_total, 6) if phases_total else None,
        "unresolved_claims_count": len(unresolved),
        "active_child_names": [str(item) for item in active],
    }


def add_alert(alerts: list[dict[str, Any]], code: str, severity: str, message: str, **metrics: Any) -> None:
    alerts.append({"code": code, "severity": severity, "message": message, "metrics": metrics})


def derive_alerts(scorecard: dict[str, Any], *, min_evidence_per_100_lines: float,
                  churn_alert_min_lines: int, goal_low_percent: float,
                  completion: bool = False) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []
    task = scorecard["task"]
    goal = scorecard["goal"]
    gates = scorecard["gates"]
    evidence = scorecard["verification"]
    churn = scorecard["code_churn"]
    children = scorecard["children"]
    usage = scorecard["usage"]
    if task["task_id"] is None:
        add_alert(alerts, "NO_TASK_STATE", "critical", "No readable task state; metrics cannot be scoped reliably.")
    if task["unresolved_claims_count"]:
        add_alert(alerts, "UNRESOLVED_CLAIMS", "critical", "Task state contains unresolved claims.", count=task["unresolved_claims_count"])
    if task["working_branch"] and churn["working_branch"] and task["working_branch"] != churn["working_branch"]:
        add_alert(alerts, "BRANCH_MISMATCH", "critical", "Current Git branch differs from task working branch.", expected=task["working_branch"], actual=churn["working_branch"])
    if goal is None:
        add_alert(alerts, "GOAL_MISSING", "warning", "No durable thread_goal_state event was found in the session log.")
    else:
        if goal.get("status") not in {"active", None}:
            add_alert(alerts, "GOAL_INACTIVE", "warning", "The latest durable goal state is not active.", status=goal.get("status"))
        if goal.get("remaining_tokens") is not None and goal.get("token_budget"):
            remaining_rate = goal["remaining_tokens"] / goal["token_budget"]
            if remaining_rate * 100 <= goal_low_percent:
                add_alert(alerts, "GOAL_BUDGET_LOW", "critical", "Persistent goal token budget is near exhaustion.", remaining_tokens=goal["remaining_tokens"], remaining_rate=round(remaining_rate, 6))
    if gates["runs_total"] == 0:
        add_alert(alerts, "NO_GATE_RUNS", "warning", "No archived composite gate runs were found in the task window.")
    else:
        if gates["latest"] and gates["latest"]["status"] in {"fail", "error"}:
            add_alert(alerts, "GATE_FAILURE", "critical", "The latest archived gate run failed or errored.", status=gates["latest"]["status"], run_id=gates["latest"]["run_id"])
        if gates["unrecovered_profiles"]:
            add_alert(alerts, "GATE_PROFILE_UNRECOVERED", "critical", "At least one gate profile has no newer substantive passing run after its latest substantive failure.", profiles=gates["unrecovered_profiles"])
        elif gates["status_counts"].get("fail", 0) or gates["status_counts"].get("error", 0):
            add_alert(alerts, "GATE_HISTORY_FAILURES", "info", "Earlier substantive gate failures were recovered by newer substantive runs in the same profile.", status_counts=gates["status_counts"])
        if gates["vacuous_passes"]:
            add_alert(alerts, "GATE_VACUOUS_PASS", "warning", "One or more passing gate runs executed zero applicable checks.", count=gates["vacuous_passes"])
        incomplete_gate_count = gates["incomplete_runs"] + gates["incomplete_archives"]
        if incomplete_gate_count:
            add_alert(alerts, "GATE_INCOMPLETE", "warning", "Gate archives are missing a result or contain incomplete/unknown schema fields.", count=incomplete_gate_count)
        if gates["substantive_runs"] == 0:
            add_alert(alerts, "NO_APPLICABLE_GATE_CHECKS", "warning", "Gate runs occurred but every run was vacuous.")
    if evidence["task_evidence_ids"] == 0:
        add_alert(alerts, "TASK_ATTRIBUTION_GAP", "critical", "Task state names no evidence IDs; ledger rows are not attributed by timestamp guessing.")
    if evidence["missing_task_evidence_ids"]:
        add_alert(alerts, "EVIDENCE_ID_MISSING", "critical", "Task state references evidence IDs absent from the readable ledger snapshot.", count=evidence["missing_task_evidence_ids"])
    if evidence["outside_task_records"]:
        add_alert(alerts, "EVIDENCE_OUTSIDE_TASK", "info", "Time-window ledger rows not named by task evidence_ids were excluded.", count=evidence["outside_task_records"])
    coverage = evidence.get("directory_coverage")
    if completion and (not churn.get("base_resolved") or not churn.get("head")):
        add_alert(
            alerts, "VERIFICATION_CHURN_BASE_UNAVAILABLE", "critical",
            "Completion requires a resolvable task base and repository HEAD.",
            base=churn.get("base"), head=churn.get("head"),
        )
    elif completion and churn.get("base_ancestor_head") is not True:
        add_alert(
            alerts, "VERIFICATION_CHURN_RANGE_INVALID", "critical",
            "Completion requires the task base to be an ancestor of repository HEAD.",
            base=churn.get("base"), head=churn.get("head"),
        )
    elif completion and churn.get("base_equals_head"):
        add_alert(
            alerts, "VERIFICATION_CHURN_INTERVAL_EMPTY", "critical",
            "Completion refuses an empty/reset task churn interval.",
            base=churn.get("base"), head=churn.get("head"),
        )
    if completion and (
        not churn.get("highest_observed_head")
        or churn.get("highest_observed_head_ancestor") is not True
    ):
        add_alert(
            alerts, "VERIFICATION_HEAD_REGRESSION", "critical",
            "Completion requires the task's highest observed HEAD to resolve and remain an ancestor of current HEAD.",
            highest_observed_head=churn.get("highest_observed_head"), head=churn.get("head"),
        )
    if isinstance(coverage, dict) and coverage.get("available"):
        behind = [row for row in coverage.get("directories", []) if row.get("status") == "behind"]
        if behind:
            add_alert(
                alerts, "VERIFICATION_BEHIND_CHURN", "critical" if completion else "warning",
                "Verification-ledger activity is below the configured threshold in one or more changed code directories.",
                directories=[row["directory"] for row in behind],
                directory_metrics=behind,
                threshold=min_evidence_per_100_lines,
            )
    elif completion:
        add_alert(
            alerts, "VERIFICATION_COVERAGE_UNAVAILABLE", "critical",
            "Completion coverage cannot be established from the evidence ledger schema.",
        )
    else:
        code_lines = churn["code_lines_changed"]
        activity = evidence["activity_records"]
        if code_lines >= churn_alert_min_lines:
            rate = activity * 100.0 / code_lines if code_lines else 0.0
            if rate < min_evidence_per_100_lines:
                add_alert(alerts, "VERIFICATION_BEHIND_CHURN", "warning", "Verification-ledger activity is low relative to code churn (heuristic, not a correctness verdict).", activity_records=activity, code_lines_changed=code_lines, records_per_100_lines=round(rate, 6), threshold=min_evidence_per_100_lines)
    if evidence["verified_without_verifier"]:
        add_alert(alerts, "UNVERIFIED_VERIFIER_METADATA", "critical", "Verified evidence rows are missing verifier metadata.", count=evidence["verified_without_verifier"])
    stale = [child["name"] for child in children["records"] if child["possibly_stale"]]
    dead = [child["name"] for child in children["records"] if child["dead"]]
    if stale:
        add_alert(alerts, "STALE_CHILD", "warning", "Running children have no recent durable event and no valid result.", count=len(stale), names=stale)
    if dead:
        add_alert(alerts, "DEAD_CHILD", "critical", "Orchestrated children terminated or disappeared without a valid result contract.", count=len(dead), names=dead)
    if children["active_state_mismatches"]:
        add_alert(alerts, "ACTIVE_CHILD_MISMATCH", "warning", "Task active-child state disagrees with running, unreported registry children.", names=children["active_state_mismatches"])
    if usage["unattributed"] or usage["ambiguous"]:
        add_alert(alerts, "UNATTRIBUTED_CHILD_USAGE", "warning", "Some child_usage_attributed events could not be mapped uniquely without emitting prompt content.", unattributed_targets=len(usage["unattributed"]), ambiguous_targets=len(usage["ambiguous"]))
    if not scorecard["inputs"]["session_file_present"]:
        add_alert(alerts, "TELEMETRY_MISSING", "critical", "The root session JSONL was not readable.")
    if any("future_" in warning or ":future" in warning for warning in scorecard["warnings"]):
        add_alert(alerts, "FUTURE_EVENT", "warning", "Events beyond the bounded live-clock skew were excluded.")
    if scorecard["warnings"]:
        add_alert(alerts, "INPUT_ANOMALY", "warning", "One or more durable inputs were missing or malformed.", count=len(scorecard["warnings"]))
    alerts.sort(key=lambda item: (SEVERITY_ORDER.get(item["severity"], 99), item["code"]))
    return alerts

def load_artifacts_dir(root: Path, document: dict[str, Any] | None = None) -> Path:
    data = load_harness_config(root) if document is None else document
    value = data.get("artifacts_dir", "artifacts/harness")
    if (
        not isinstance(value, str) or not value or len(value) > 256 or "\\" in value
        or "\0" in value or Path(value).is_absolute() or ".." in Path(value).parts
    ):
        raise ValueError("artifacts_dir must be a bounded repository-relative forward-slash path")
    return root / value


def discover_session_file(session_dir: Path | None, registry: Path | None) -> Path | None:
    # Derive the root log only from trusted local layout/host overrides. Registry
    # parentSessionFile values remain untrusted absolute paths and are not followed;
    # operators can authorize another path explicitly with --session-file.
    del registry
    if session_dir is None:
        return None
    session_name = f"{session_dir.name}.jsonl"
    session_directories: list[Path] = []
    override = (
        os.environ.get("PRIME_AGENT_SESSION_DIR")
        or os.environ.get("PRIME_AGENT_CODING_AGENT_SESSION_DIR")
    )
    if override:
        explicit_candidate = Path(os.path.expanduser(override)) / session_name
        return explicit_candidate if explicit_candidate.is_file() else None
    session_directories.append(session_dir.parent.parent / "sessions")
    coding_agent_dir = os.environ.get("PRIME_AGENT_CODING_AGENT_DIR")
    if coding_agent_dir:
        session_directories.append(Path(os.path.expanduser(coding_agent_dir)) / "sessions")
    session_directories.append(Path.home() / ".prime" / "agent" / "sessions")

    seen: set[str] = set()
    for directory in session_directories:
        key = os.path.normcase(os.path.abspath(directory))
        if key in seen:
            continue
        seen.add(key)
        candidate = directory / session_name
        if candidate.is_file():
            return candidate
    return None


def build_scorecard(*, root: Path, task_state_path: Path, session_file: Path | None,
                    registry_path: Path | None, children_state_path: Path,
                    evidence_db: Path, gate_logs: Path, now: datetime,
                    stale_minutes: float, base_override: str | None,
                    min_evidence_per_100_lines: float, churn_alert_min_lines: int,
                    goal_low_percent: float, exempt_globs: list[str] | None = None,
                    completion: bool = False,
                    future_skew_seconds: float = FUTURE_EVENT_SKEW_SECONDS) -> dict[str, Any]:
    warnings: list[str] = []
    task_data = read_json(task_state_path, warnings, "task_state")
    task = task_summary(task_data)
    start = parse_time(task.get("created_at"))
    if task.get("created_at") and start is None:
        warnings.append("task_state:invalid_created_at")
    if start is not None and start > now:
        warnings.append("task_state:future_created_at")
    session = scan_session(
        session_file, start, now, warnings, future_skew_seconds
    )
    registry = scan_registry(
        registry_path, start, now, stale_minutes, warnings, future_skew_seconds
    )
    usage = attribute_child_usage(session, registry, warnings)
    known_task_usage = empty_usage()
    add_usage(known_task_usage, public_usage(session["parent_usage"]), warnings, "usage:known_parent")
    add_usage(known_task_usage, usage["totals"], warnings, "usage:known_children")
    usage["known_task_total"] = public_usage(known_task_usage)
    control = scan_children_state(
        children_state_path,
        task_state_path.parent,
        start,
        now,
        warnings,
        future_skew_seconds,
    )
    usage["children"] = enrich_child_lifecycle(usage["children"], control)
    gates = scan_gates(gate_logs, start, now, warnings)
    task_evidence_ids = [
        item for item in (task_data.get("evidence_ids", []) if isinstance(task_data, dict) else [])
        if isinstance(item, str) and item
    ]
    evidence = scan_evidence(evidence_db, start, now, task_evidence_ids, warnings)
    coverage_records = evidence.pop("_coverage_records", [])
    configured_exempt_globs = list(exempt_globs or [])
    churn = scan_churn(
        root, base_override or task.get("base_commit"), warnings,
        exempt_globs=configured_exempt_globs,
        binary_charge_lines=churn_alert_min_lines,
        highest_observed_head=task.get("highest_observed_head"),
    )
    evidence["directory_coverage"] = build_directory_coverage(
        root=root,
        base=base_override or task.get("base_commit"),
        churn=churn,
        coverage_records=coverage_records,
        schema_available=bool(evidence.get("coverage_schema_available")),
        min_evidence_per_100_lines=min_evidence_per_100_lines,
        churn_alert_min_lines=churn_alert_min_lines,
        exempt_globs=configured_exempt_globs,
        warnings=warnings,
    )
    code_lines = churn["code_lines_changed"]
    evidence["records_per_100_code_lines"] = round(evidence["activity_records"] * 100.0 / code_lines, 6) if code_lines else None
    evidence["gate_runs_per_100_code_lines"] = round(gates["substantive_runs"] * 100.0 / code_lines, 6) if code_lines else None
    status_counts = Counter(child["status"] for child in usage["children"])
    active_names = set(task["active_child_names"])
    actual_running = {
        child["name"] for child in usage["children"]
        if child["status"].lower() in RUNNING_STATUSES and not child["reported"]
    }
    mismatches = sorted(active_names.symmetric_difference(actual_running))
    scorecard: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": iso_utc(now),
        "window": {"start": iso_utc(start) if start else None, "end": iso_utc(now)},
        "task": task,
        "goal": goal_summary(session["goal"]),
        "usage": {"parent": public_usage(session["parent_usage"]), **usage},
        "gates": gates,
        "verification": evidence,
        "code_churn": churn,
        "children": {
            "total": len(usage["children"]),
            "status_counts": dict(sorted(status_counts.items())),
            "possibly_stale_count": sum(1 for child in usage["children"] if child["possibly_stale"]),
            "dead_count": sum(1 for child in usage["children"] if child["dead"]),
            "reported_count": sum(1 for child in usage["children"] if child["reported"]),
            "missing_session_files": sum(1 for child in usage["children"] if not child["session_file_present"]),
            "active_state_mismatches": mismatches,
            "records": usage["children"],
        },
        "inputs": {
            "task_state": short_path(task_state_path, root),
            "task_state_present": task_state_path.is_file(),
            "session_file": session_file.name if session_file else None,
            "session_file_present": bool(session_file and session_file.is_file()),
            "registry": registry_path.name if registry_path else None,
            "registry_present": bool(registry_path and registry_path.is_file()),
            "children_state": short_path(children_state_path, root),
            "children_state_present": control["present"],
            "evidence_db": short_path(evidence_db, root),
            "evidence_db_present": evidence_db.is_file(),
            "gate_logs": short_path(gate_logs, root),
            "gate_logs_present": gate_logs.is_dir(),
            "session_entries_seen": session["entries_seen"],
        },
        "warnings": sorted(set(warnings)),
        "alerts": [],
    }
    scorecard["alerts"] = derive_alerts(
        scorecard,
        min_evidence_per_100_lines=min_evidence_per_100_lines,
        churn_alert_min_lines=churn_alert_min_lines,
        goal_low_percent=goal_low_percent,
        completion=completion,
    )
    return scorecard

def markdown_summary(scorecard: dict[str, Any]) -> str:
    def cell(value: Any) -> str:
        escaped = html.escape(str(value), quote=True).replace("`", "&#96;")
        return escaped.replace("|", "\\|").replace("\n", " ")

    lines = [
        "# Prime Harness task scorecard",
        "",
        f"Generated: `{cell(scorecard['generated_at'])}`  ",
        f"Task: `{cell(scorecard['task']['task_id'])}`  ",
        f"Phase progress: `{scorecard['task']['phases_passed']}/{scorecard['task']['phases_total']}`  ",
        f"Archived gate pass rate: `{scorecard['gates']['archived_pass_rate']}`  ",
        f"Substantive gate pass rate: `{scorecard['gates']['substantive_pass_rate']}`  ",
        f"Known task tokens: `{scorecard['usage']['known_task_total']['totalTokens']}`  ",
        f"Known task cost: `{scorecard['usage']['known_task_total']['cost']['total']:.6f}`  ",
        f"Code churn: `{scorecard['code_churn']['code_lines_changed']}` lines  ",
        f"Verification activity: `{scorecard['verification']['activity_records']}` records  ",
        "",
        "## Alerts",
        "",
    ]
    if not scorecard["alerts"]:
        lines.append("- None.")
    else:
        for alert in scorecard["alerts"]:
            lines.append(f"- **{cell(alert['severity'].upper())} `{cell(alert['code'])}`** -- {cell(alert['message'])}")
    lines.extend(["", "## Child usage", "", "| Child | Status | Tokens | Cost |", "|---|---:|---:|---:|"])
    for child in scorecard["usage"]["children"]:
        lines.append(f"| {cell(child['name'])} | {cell(child['status'])} | {child['usage']['totalTokens']} | {child['usage']['cost']['total']:.6f} |")
    return "\n".join(lines) + "\n"


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def repo_root(start: Path) -> Path:
    resolved = start.resolve()
    for candidate in (resolved, *resolved.parents):
        if (candidate / ".git").exists():
            return candidate
    return resolved


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="repository root (default: discover from cwd)")
    parser.add_argument("--task-state", type=Path)
    parser.add_argument("--session-file", type=Path)
    parser.add_argument("--session-dir", type=Path)
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--children-state", type=Path, help="orchestrator children.json (default: task artifact directory)")
    parser.add_argument("--evidence-db", type=Path)
    parser.add_argument("--gate-logs", type=Path)
    parser.add_argument("--base", help="override task-state base commit")
    parser.add_argument("--now", help="deterministic ISO-8601 clock (tests/replay)")
    parser.add_argument("--stale-minutes", type=float, default=30.0)
    parser.add_argument("--min-evidence-per-100-lines", type=float, help="override config verification-coverage threshold")
    parser.add_argument("--churn-alert-min-lines", type=int, help="override config verification-coverage churn floor")
    parser.add_argument("--goal-low-percent", type=float, default=5.0)
    parser.add_argument("--output", type=Path, help="atomically write JSON (stdout when omitted)")
    parser.add_argument("--markdown", type=Path, help="atomically write a Markdown summary")
    parser.add_argument("--fail-on", choices=("never", "warning", "critical"), default="never")
    parser.add_argument("--completion", action="store_true", help="make unresolved directory coverage completion-fatal")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = repo_root(args.repo)
    try:
        config_document = load_harness_config(root)
        policy = load_coverage_policy(root, config_document)
        artifacts = load_artifacts_dir(root, config_document)
    except ValueError as exc:
        print(f"scorecard: {exc}", file=sys.stderr)
        return 2
    min_evidence = (
        args.min_evidence_per_100_lines
        if args.min_evidence_per_100_lines is not None
        else policy["min_evidence_per_100_lines"]
    )
    churn_minimum = (
        args.churn_alert_min_lines
        if args.churn_alert_min_lines is not None
        else policy["churn_alert_min_lines"]
    )
    if (
        args.stale_minutes < 0
        or isinstance(min_evidence, bool)
        or not math.isfinite(min_evidence)
        or min_evidence < float(DEFAULT_COVERAGE_POLICY["min_evidence_per_100_lines"])
        or not 0 <= churn_minimum <= int(DEFAULT_COVERAGE_POLICY["churn_alert_min_lines"])
        or not 0 <= args.goal_low_percent <= 100
    ):
        print("scorecard: invalid non-negative threshold", file=sys.stderr)
        return 2
    now = parse_time(args.now) if args.now else utc_now()
    if now is None:
        print("scorecard: --now must be ISO-8601 or an epoch timestamp", file=sys.stderr)
        return 2
    session_dir = args.session_dir or (Path(os.environ["RLM_SESSION_DIR"]) if os.environ.get("RLM_SESSION_DIR") else None)
    registry = args.registry or (session_dir / "rlm-subagents.jsonl" if session_dir else None)
    session_file = args.session_file or discover_session_file(session_dir, registry)
    scorecard = build_scorecard(
        root=root,
        task_state_path=args.task_state or artifacts / "task-state.json",
        session_file=session_file,
        registry_path=registry,
        children_state_path=args.children_state or artifacts / "children.json",
        evidence_db=args.evidence_db or artifacts / "evidence.db",
        gate_logs=args.gate_logs or artifacts / "gate-logs",
        now=now,
        stale_minutes=args.stale_minutes,
        base_override=args.base,
        min_evidence_per_100_lines=float(min_evidence),
        churn_alert_min_lines=churn_minimum,
        goal_low_percent=args.goal_low_percent,
        exempt_globs=policy["exempt_globs"],
        completion=args.completion,
        future_skew_seconds=(0.0 if args.now else FUTURE_EVENT_SKEW_SECONDS),
    )
    scorecard["completion_mode"] = args.completion
    payload = json.dumps(scorecard, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"
    if args.output:
        atomic_write(args.output, payload)
    else:
        sys.stdout.write(payload)
    if args.markdown:
        atomic_write(args.markdown, markdown_summary(scorecard))
    severities = {alert["severity"] for alert in scorecard["alerts"]}
    if args.fail_on == "critical" and "critical" in severities:
        return 1
    if args.fail_on == "warning" and severities.intersection({"warning", "critical"}):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
