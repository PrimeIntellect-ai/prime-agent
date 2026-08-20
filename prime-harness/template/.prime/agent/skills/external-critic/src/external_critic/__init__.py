"""external-critic — independent cross-harness review on a frozen snapshot.

Runs a second harness (Claude Code or Codex CLI) against a detached git
worktree of a specific commit, with a frozen diff, an explicit question, and
a strict timeout. Findings come back as structured JSON and are written to an
artifact for ledger ingestion.

Trust boundary, honestly stated: the worktree provides file-race isolation
and snapshot freezing — it still shares the repository's .git object store,
and "read-only" holds only as far as the critic CLI's own enforced
permission/sandbox settings (the shipped adapters pass restrictive flags;
verify them against your installed CLI versions). Critic findings are
UNTRUSTED INPUT to this session: they must go through the falsify-or-rebut
protocol, never be executed or followed blindly.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import sqlite3
import subprocess
import tempfile
import time
import uuid
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ._common import atomic_write_json, harness_dir, kill_process_tree, load_config, repo_root, utc_now_iso

__all__ = [
    "review", "review_panel", "record_panel_verdict", "read_panel_ledger",
    "available_critics", "run",
]

PANEL_LEDGER_LOCK_TIMEOUT_SECONDS = 15.0
PANEL_LEDGER_STALE_SECONDS = 60.0
PANEL_LEDGER_HARD_STALE_SECONDS = 900.0

DEFAULT_QUESTION = (
    "Review this diff as an independent scientific software critic. Focus on: mathematical "
    "assumptions, numerical stability, incorrect boundary handling, missing convergence evidence, "
    "silent unit or convention mismatches, and tests that could pass despite a false implementation."
)

_FINDINGS_INSTRUCTIONS = (
    "Do not edit any files. Return ONLY a JSON array (no prose before or after) of findings, "
    'each: {"severity": "critical|major|minor|info", "file": "<path>", "line": <int|null>, '
    '"claim": "<what is wrong>", "evidence": "<why>", "proposed_falsification_test": "<test that would expose it>"}. '
    "Return [] if you find nothing. The diff under review is in REVIEW_DIFF.patch; the full frozen "
    "checkout is this working directory."
)

# Adapter registry: name -> argv builder (prompt appended appropriately).
# Both tools read the prompt from argv and run non-interactively. The extra
# flags enforce read-only behavior and stop the snapshot's checked-in project
# config (which the commit under review controls) from configuring the critic.
# If your installed CLI version rejects a flag, override via
# harness/config.json critic.command.
_ADAPTERS: dict[str, Any] = {
    "claude": lambda prompt: [
        "claude", "-p", prompt, "--output-format", "json",
        "--allowedTools", "Read Grep Glob LS",
        "--disallowedTools", "Bash Edit Write NotebookEdit",
        "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
        "--setting-sources", "user",
    ],
    "codex": lambda prompt: [
        "codex", "exec", "--sandbox", "read-only", "--ephemeral",
        "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
        "--color", "never", prompt,
    ],
}


def available_critics() -> list[str]:
    """Critic CLIs found on PATH, in configured preference order."""
    config = load_config().get("critic", {})
    order = config.get("order") or ["claude", "codex"]
    return [name for name in order if name in _ADAPTERS and shutil.which(name)]


def _extract_json_array(text: str) -> list[dict[str, Any]] | None:
    """Extract one unambiguous findings array from possibly-noisy output."""
    text = text.strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed if all(isinstance(item, dict) for item in parsed) else None
        if isinstance(parsed, dict):
            # claude --output-format json wraps the answer in {"result": "..."}
            inner = parsed.get("result")
            if isinstance(inner, str):
                return _extract_json_array(inner)
            if isinstance(inner, list):
                return inner if all(isinstance(item, dict) for item in inner) else None
    except json.JSONDecodeError:
        pass
    # Collect balanced top-level arrays while honoring JSON string escapes. Regex
    # extraction mistakes examples such as "input [{}]" inside a finding for a
    # second response and turns a valid workstream into an availability failure.
    candidates: list[str] = []
    candidate_ends: list[int] = []
    for fence_body in re.findall(r"```(?:json)?\s*(.*?)\s*```", text, flags=re.DOTALL):
        candidates.append(fence_body.strip())

    depth = 0
    start: int | None = None
    in_string = False
    escaped = False
    for index, character in enumerate(text):
        if depth == 0:
            # Quotes in surrounding prose are not JSON syntax. Start string
            # tracking only after a candidate array has opened.
            if character == "[":
                start = index
                depth = 1
                in_string = False
                escaped = False
            continue
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character == "[":
            depth += 1
        elif character == "]":
            depth -= 1
            if depth == 0 and start is not None:
                candidates.append(text[start : index + 1])
                candidate_ends.append(index)
                start = None

    if depth > 0:
        return None
    distinct: dict[str, list[dict[str, Any]]] = {}
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list) and all(isinstance(item, dict) for item in parsed):
            canonical = json.dumps(parsed, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            distinct.setdefault(canonical, parsed)
    if len(distinct) != 1 or not candidate_ends:
        return None
    result = next(iter(distinct.values()))
    last_end = max(candidate_ends)
    trailing = text[last_end + 1 :].strip()
    if trailing.startswith("```"):
        trailing = trailing[3:].strip()
    if trailing.casefold() not in {"", "done", "done."}:
        return None
    if not result and not re.search(r"\b(?:no issues|no findings|nothing to report)\b", text[:last_end], re.IGNORECASE):
        return None
    return result


def _validate_findings(findings: list[dict[str, Any]]) -> str | None:
    required_strings = ("claim", "evidence", "proposed_falsification_test")
    for index, finding in enumerate(findings):
        severity = str(finding.get("severity", "")).casefold()
        if severity not in {"critical", "major", "minor", "info"}:
            return f"finding {index} has invalid severity"
        file_name = finding.get("file")
        if not isinstance(file_name, str) or not file_name.strip() or len(file_name) > 4096:
            return f"finding {index} has invalid file"
        normalized = file_name.replace("\\", "/")
        pure = Path(normalized)
        if pure.is_absolute() or any(part == ".." for part in normalized.split("/")) or "\x00" in normalized:
            return f"finding {index} file is not a confined relative path"
        line = finding.get("line")
        if line is not None and (type(line) is not int or line < 1):
            return f"finding {index} has invalid line"
        for field in required_strings:
            value = finding.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > 20000:
                return f"finding {index} has invalid {field}"
    return None


def _prepare_argv_and_input(tool: str, prompt: str, argv: list[str]) -> tuple[list[str], str | None]:
    """Keep known-vendor prompts off argv/process listings by using stdin."""
    prepared = list(argv)
    if tool == "claude":
        prepared = [argument for argument in prepared if argument != prompt]
        return prepared, prompt
    if tool == "codex":
        prepared = ["-" if argument == prompt else argument for argument in prepared]
        return prepared, prompt
    return prepared, None


def _redacted_argv(argv: list[str], prompt: str) -> list[str]:
    marker = f"<prompt sha256={hashlib.sha256(prompt.encode('utf-8')).hexdigest()}>"
    return [marker if argument == prompt else argument for argument in argv]


def _git(args: list[str], cwd: Path, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    # explicit UTF-8: git emits UTF-8 regardless of the Windows cp1252 locale
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)


def review(
    question: str = "",
    *,
    base: str | None = None,
    head: str = "HEAD",
    tool: str | None = None,
    timeout_seconds: int | None = None,
    extra_context: str = "",
) -> dict[str, Any]:
    """Run an independent critic over base..head on a frozen worktree.

    Returns {status, tool, findings, findings_path, base, head, raw_output_path}.
    status: 'done' (findings parsed), 'error' (setup/parse/timeout failure).
    Never modifies the canonical worktree; the snapshot is always removed.
    """
    root = repo_root()
    config = load_config().get("critic", {})
    timeout_seconds = timeout_seconds or int(config.get("timeout_seconds", 900))

    override = config.get("command")
    if tool is None and override:
        tool = "custom"
    critics = available_critics()
    if tool is None:
        if not critics:
            return {"status": "error", "reason": "no critic CLI found on PATH "
                    f"(looked for {list(_ADAPTERS)}); set harness/config.json critic.command"}
        tool = critics[0]

    if base is None:
        for candidate in ("origin/main", "origin/master", "main", "master"):
            if _git(["rev-parse", "--verify", "--quiet", candidate], root).returncode == 0:
                base = candidate
                break
    if base is None:
        return {"status": "error", "reason": "could not resolve a base ref; pass base= explicitly"}

    base_sha_proc = _git(["rev-parse", f"{base}^{{commit}}"], root)
    if base_sha_proc.returncode != 0:
        return {"status": "error", "reason": f"cannot resolve base {base!r}: {base_sha_proc.stderr.strip()}"}
    base_sha = base_sha_proc.stdout.strip()
    head_sha_proc = _git(["rev-parse", f"{head}^{{commit}}"], root)
    if head_sha_proc.returncode != 0:
        return {"status": "error", "reason": f"cannot resolve head {head!r}: {head_sha_proc.stderr.strip()}"}
    head_sha = head_sha_proc.stdout.strip()

    diff_proc = _git(["diff", f"{base_sha}...{head_sha}"], root, timeout=300)
    if diff_proc.returncode != 0:
        return {"status": "error", "reason": f"git diff failed: {(diff_proc.stderr or '').strip()}"}

    out_dir = harness_dir() / "critic"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = utc_now_iso().replace(":", "").replace("+", "Z") + "-" + uuid.uuid4().hex[:8]

    if not (diff_proc.stdout or "").strip():
        # consistent contract: every "done" result carries findings_path/counts
        findings_path = out_dir / f"{stamp}-empty-diff-findings.json"
        atomic_write_json(findings_path, {
            "source": "external-critic:none", "claim": f"independent review of {base}...{head_sha[:12]}",
            "status": "done", "base": base, "base_sha": base_sha, "head": head_sha, "findings": [],
            "note": "empty diff — nothing to review", "created_at": utc_now_iso(),
        })
        return {"status": "done", "tool": tool, "findings": [], "base": base, "base_sha": base_sha, "head": head_sha,
                "findings_path": str(findings_path), "counts": {},
                "note": "empty diff — nothing to review"}

    snapshot = Path(tempfile.mkdtemp(prefix="prime-critic-")) / f"snap-{uuid.uuid4().hex[:8]}"

    try:
        add = _git(["worktree", "add", "--detach", str(snapshot), head_sha], root, timeout=300)
        if add.returncode != 0:
            return {"status": "error", "reason": f"git worktree add failed: {add.stderr.strip()}"}

        (snapshot / "REVIEW_DIFF.patch").write_text(diff_proc.stdout, encoding="utf-8")
        _neutralize_snapshot_links(snapshot)
        snapshot_fingerprint = _snapshot_fingerprint(snapshot)
        prompt = "\n\n".join(part for part in [
            (question or DEFAULT_QUESTION).strip(),
            extra_context.strip(),
            f"Diff range: {base}...{head_sha[:12]}",
            _FINDINGS_INSTRUCTIONS,
        ] if part)

        if tool == "custom":
            # critic.command is argv template; "{prompt}" placeholder or prompt appended
            template = list(override)
            argv = [arg.replace("{prompt}", prompt) for arg in template]
            if all("{prompt}" not in arg for arg in template):
                argv.append(prompt)
        else:
            argv = _ADAPTERS[tool](prompt)
        argv, prompt_input = _prepare_argv_and_input(tool, prompt, argv)

        # Resolve the executable: on Windows, npm-installed CLIs are .cmd shims
        # that CreateProcess cannot launch by bare name.
        resolved = shutil.which(argv[0])
        if resolved is None:
            return {"status": "error", "tool": tool,
                    "reason": f"critic executable {argv[0]!r} not found on PATH"}
        argv[0] = resolved
        logged_argv = _redacted_argv(argv, prompt)

        popen_kwargs: dict[str, Any] = {
            "cwd": str(snapshot), "stdout": subprocess.PIPE, "stderr": subprocess.PIPE,
            "text": True, "encoding": "utf-8", "errors": "replace",
        }
        if prompt_input is not None:
            popen_kwargs["stdin"] = subprocess.PIPE
        if os.name != "nt":
            popen_kwargs["start_new_session"] = True  # lets kill_process_tree reach grandchildren
        try:
            proc = subprocess.Popen(argv, **popen_kwargs)
        except OSError as exc:
            return {"status": "error", "tool": tool, "reason": f"failed to launch critic: {exc}"}
        try:
            stdout, stderr = proc.communicate(input=prompt_input, timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            kill_process_tree(proc)
            try:  # drain what the (now killed) tree produced; bounded
                stdout, stderr = proc.communicate(timeout=15)
            except (subprocess.TimeoutExpired, ValueError):
                stdout, stderr = "", ""
            raw_path = out_dir / f"{stamp}-{tool}-raw.txt"
            raw_path.write_text(f"# argv: {logged_argv}\n# TIMED OUT after {timeout_seconds}s\n\n"
                                f"## stdout\n{stdout}\n\n## stderr\n{stderr}", encoding="utf-8")
            return {"status": "error", "tool": tool, "raw_output_path": str(raw_path),
                    "reason": f"critic timed out after {timeout_seconds}s (process tree killed)"}
        stdout, stderr = stdout or "", stderr or ""

        raw_path = out_dir / f"{stamp}-{tool}-raw.txt"
        raw_path.write_text(
            f"# argv: {logged_argv}\n# exit: {proc.returncode}\n\n## stdout\n{stdout}\n\n## stderr\n{stderr}",
            encoding="utf-8",
        )

        if proc.returncode != 0:
            return {"status": "error", "tool": tool, "base": base, "base_sha": base_sha,
                    "head": head_sha, "reason": f"critic exited nonzero ({proc.returncode})",
                    "raw_output_path": str(raw_path)}
        findings = _extract_json_array(stdout)
        if findings is None:
            return {"status": "error", "tool": tool, "base": base, "base_sha": base_sha, "head": head_sha,
                    "reason": "could not parse a JSON findings array from critic output",
                    "raw_output_path": str(raw_path)}
        schema_error = _validate_findings(findings)
        if schema_error:
            return {"status": "error", "tool": tool, "base": base, "base_sha": base_sha, "head": head_sha,
                    "reason": f"invalid findings schema: {schema_error}",
                    "raw_output_path": str(raw_path)}
        try:
            freeze_changed = _snapshot_fingerprint(snapshot) != snapshot_fingerprint
        except RuntimeError:
            freeze_changed = True
        if freeze_changed:
            return {"status": "error", "tool": tool, "base": base, "base_sha": base_sha, "head": head_sha,
                    "reason": "critic modified its frozen snapshot (freeze violation)",
                    "raw_output_path": str(raw_path)}

        findings_path = out_dir / f"{stamp}-{tool}-findings.json"
        atomic_write_json(findings_path, {
            "source": f"external-critic:{tool}",
            "claim": f"independent review of {base}...{head_sha[:12]}",
            "status": "done",
            "base": base, "base_sha": base_sha, "head": head_sha, "question": question or DEFAULT_QUESTION,
            "findings": findings, "created_at": utc_now_iso(),
        })
        return {"status": "done", "tool": tool, "findings": findings, "base": base, "base_sha": base_sha, "head": head_sha,
                "findings_path": str(findings_path), "raw_output_path": str(raw_path),
                "counts": _severity_counts(findings)}
    finally:
        _git(["worktree", "remove", "--force", str(snapshot)], root, timeout=120)
        shutil.rmtree(snapshot.parent, ignore_errors=True)
        _git(["worktree", "prune"], root, timeout=60)


def _severity_counts(findings: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for finding in findings:
        severity = str(finding.get("severity", "info")).lower()
        counts[severity] = counts.get(severity, 0) + 1
    return counts



_SEVERITY_ORDER = {"info": 0, "minor": 1, "major": 2, "critical": 3}
_PANEL_DISPOSITIONS = {"open", "fixed", "rebutted", "inconclusive", "superseded"}


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                      default=str).encode("utf-8")


def _claim_tokens(value: Any) -> set[str]:
    return {token for token in re.findall(r"[a-z0-9_]+", str(value).casefold()) if len(token) > 2}


def _finding_similarity(left: dict[str, Any], right: dict[str, Any]) -> float:
    if left.get("file_key", left.get("file")) != right.get("file_key", right.get("file")):
        return 0.0
    left_line, right_line = left.get("line"), right.get("line")
    if isinstance(left_line, int) and isinstance(right_line, int) and abs(left_line - right_line) > 5:
        return 0.0
    a, b = _claim_tokens(left.get("claim")), _claim_tokens(right.get("claim"))
    if not a and not b:
        return 1.0
    return len(a & b) / max(1, len(a | b))


def _normalize_one_finding(tool: str, index: int, finding: dict[str, Any]) -> dict[str, Any]:
    severity = str(finding.get("severity", "info")).casefold()
    if severity not in _SEVERITY_ORDER:
        severity = "info"
    file_name = str(finding.get("file") or "<unknown>").replace("\\", "/")
    while file_name.startswith("./"):
        file_name = file_name[2:]
    line = finding.get("line")
    if type(line) is not int or line < 1:
        line = None
    return {
        "tool": tool,
        "source_index": index,
        "severity": severity,
        "file": file_name,
        "file_key": file_name.casefold(),
        "line": line,
        "claim": str(finding.get("claim") or "").strip(),
        "evidence": str(finding.get("evidence") or "").strip(),
        "proposed_falsification_test": str(finding.get("proposed_falsification_test") or "").strip(),
        "raw": finding,
    }


def _canonical_claim(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value)).strip().casefold()


def _normalize_panel_findings(workstreams: dict[str, dict[str, Any]], required_tools: list[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    positions: list[dict[str, Any]] = []
    for tool in sorted(required_tools):
        stream = workstreams.get(tool, {})
        if stream.get("status") != "done":
            continue
        for index, finding in enumerate(stream.get("findings") or []):
            positions.append(_normalize_one_finding(tool, index, finding))
    positions.sort(key=lambda item: (
        item["file"].encode("utf-8"), item["line"] if item["line"] is not None else 2**31,
        _canonical_claim(item["claim"]), item["tool"], item["source_index"],
    ))
    grouped: dict[tuple[str, int | None, str], list[dict[str, Any]]] = {}
    for position in positions:
        key = (position["file"], position["line"], _canonical_claim(position["claim"]))
        grouped.setdefault(key, []).append(position)

    findings: list[dict[str, Any]] = []
    disagreements: list[dict[str, Any]] = []
    required = set(required_tools)
    for key in sorted(grouped, key=lambda value: (value[0].encode("utf-8"),
                                                   value[1] if value[1] is not None else 2**31,
                                                   value[2])):
        cluster = sorted(grouped[key], key=lambda item: (item["tool"], item["source_index"]))
        tools = {item["tool"] for item in cluster}
        severities = {item["severity"] for item in cluster}
        raw_claims = {item["claim"] for item in cluster}
        representative = sorted(
            cluster,
            key=lambda item: (-_SEVERITY_ORDER[item["severity"]], -len(item["evidence"]),
                              -len(item["claim"]), item["tool"]),
        )[0]
        finding_id = "pf-" + hashlib.sha256(_canonical_bytes({"file": key[0], "line": key[1],
                                                                 "claim": key[2]})).hexdigest()[:16]
        kinds: list[str] = []
        if tools != required: kinds.append("presence")
        if len(severities) > 1: kinds.append("severity")
        if len(raw_claims) > 1: kinds.append("wording")
        agreement = "consensus" if tools == required and not kinds else ("single-tool" if len(tools) == 1 else "conflict")
        item = {
            "finding_id": finding_id,
            "severity": max(severities, key=lambda value: _SEVERITY_ORDER[value]),
            "file": representative["file"], "line": representative["line"],
            "claim": representative["claim"], "evidence": representative["evidence"],
            "proposed_falsification_test": representative["proposed_falsification_test"],
            "agreement": agreement, "disagreement_types": kinds,
            "tools": sorted(tools),
            "positions": [{field: value for field, value in position.items() if field != "file_key"}
                          for position in cluster],
            "possible_overlap_ids": [], "panel_disposition": "open",
        }
        findings.append(item)
        for kind in kinds:
            disagreements.append({"finding_id": finding_id, "type": kind, "tools": sorted(tools),
                                  "detail": {"required_tools": sorted(required),
                                             "severities": sorted(severities),
                                             "claims": sorted(raw_claims)}})
    findings.sort(key=lambda item: (-_SEVERITY_ORDER[item["severity"]], item["file"].encode("utf-8"),
                                    item["line"] if item["line"] is not None else 2**31,
                                    item["finding_id"]))
    # Similar findings are linked, never merged: this cannot hide negation or a lone allegation.
    for left_index, left in enumerate(findings):
        left_position = left["positions"][0]
        for right in findings[left_index + 1:]:
            right_position = right["positions"][0]
            if _finding_similarity(left_position, right_position) >= 0.4:
                left["possible_overlap_ids"].append(right["finding_id"])
                right["possible_overlap_ids"].append(left["finding_id"])
                disagreements.append({"type": "possible_overlap_unmerged",
                                      "finding_ids": sorted([left["finding_id"], right["finding_id"]]),
                                      "detail": "similar location/tokens retained as separate exact issues"})
    for item in findings: item["possible_overlap_ids"].sort()
    disagreements.sort(key=lambda item: (item.get("finding_id", ""),
                                          ",".join(item.get("finding_ids", [])), item["type"]))
    return findings, disagreements


def _panel_workstream(
    tool: str,
    prompt: str,
    workdir: Path,
    out_dir: Path,
    panel_id: str,
    timeout_seconds: int,
    base: str,
    base_sha: str,
    head_sha: str,
) -> dict[str, Any]:
    raw_path = out_dir / f"{panel_id}-{tool}-raw.txt"
    findings_path = out_dir / f"{panel_id}-{tool}-findings.json"
    if tool not in _ADAPTERS:
        return {"status": "error", "tool": tool, "reason": "unsupported panel critic adapter"}
    argv = _ADAPTERS[tool](prompt)
    argv, prompt_input = _prepare_argv_and_input(tool, prompt, argv)
    resolved = shutil.which(argv[0])
    if resolved is None:
        return {"status": "error", "tool": tool,
                "reason": f"critic executable {argv[0]!r} not found on PATH"}
    argv[0] = resolved
    logged_argv = _redacted_argv(argv, prompt)
    input_fingerprint = _snapshot_fingerprint(workdir)
    popen_kwargs: dict[str, Any] = {
        "cwd": str(workdir), "stdout": subprocess.PIPE, "stderr": subprocess.PIPE,
        "text": True, "encoding": "utf-8", "errors": "replace",
    }
    if prompt_input is not None:
        popen_kwargs["stdin"] = subprocess.PIPE
    if os.name != "nt":
        popen_kwargs["start_new_session"] = True
    started = time.monotonic()
    try:
        proc = subprocess.Popen(argv, **popen_kwargs)
    except OSError as exc:
        return {"status": "error", "tool": tool, "reason": f"failed to launch critic: {exc}"}
    try:
        stdout, stderr = proc.communicate(input=prompt_input, timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        kill_process_tree(proc)
        try:
            stdout, stderr = proc.communicate(timeout=15)
        except (subprocess.TimeoutExpired, ValueError):
            stdout, stderr = "", ""
        raw_path.write_text(
            f"# argv: {logged_argv}\n# TIMED OUT after {timeout_seconds}s\n\n## stdout\n{stdout}\n\n## stderr\n{stderr}",
            encoding="utf-8",
        )
        return {"status": "error", "tool": tool, "raw_output_path": str(raw_path),
                "seconds": round(time.monotonic() - started, 6),
                "reason": f"critic timed out after {timeout_seconds}s (process tree killed)"}
    stdout, stderr = stdout or "", stderr or ""
    raw_path.write_text(
        f"# argv: {logged_argv}\n# exit: {proc.returncode}\n\n## stdout\n{stdout}\n\n## stderr\n{stderr}",
        encoding="utf-8",
    )
    if proc.returncode != 0:
        return {"status": "error", "tool": tool, "base": base, "base_sha": base_sha, "head": head_sha,
                "seconds": round(time.monotonic() - started, 6),
                "reason": f"critic exited nonzero ({proc.returncode})",
                "raw_output_path": str(raw_path)}
    findings = _extract_json_array(stdout)
    if findings is None:
        return {"status": "error", "tool": tool, "base": base, "base_sha": base_sha, "head": head_sha,
                "seconds": round(time.monotonic() - started, 6),
                "reason": "could not parse a JSON findings array from critic output",
                "raw_output_path": str(raw_path)}
    schema_error = _validate_findings(findings)
    if schema_error:
        return {"status": "error", "tool": tool, "base": base, "base_sha": base_sha, "head": head_sha,
                "seconds": round(time.monotonic() - started, 6),
                "reason": f"invalid findings schema: {schema_error}",
                "raw_output_path": str(raw_path)}
    if _snapshot_fingerprint(workdir) != input_fingerprint:
        return {"status": "error", "tool": tool, "base": base, "base_sha": base_sha, "head": head_sha,
                "seconds": round(time.monotonic() - started, 6),
                "reason": "critic modified its private frozen snapshot (freeze violation)",
                "raw_output_path": str(raw_path)}
    atomic_write_json(findings_path, {
        "source": f"external-critic:panel:{tool}",
        "claim": f"independent panel workstream review of {base}...{head_sha[:12]}",
        "status": "done", "base": base, "base_sha": base_sha, "head": head_sha, "findings": findings,
        "panel_id": panel_id, "created_at": utc_now_iso(),
    })
    return {
        "status": "done", "tool": tool, "base": base, "base_sha": base_sha, "head": head_sha,
        "seconds": round(time.monotonic() - started, 6), "findings": findings,
        "findings_path": str(findings_path), "raw_output_path": str(raw_path),
        "counts": _severity_counts(findings),
    }


def _ledger_path() -> Path:
    path = harness_dir() / "critic" / "panel-verdict-ledger.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _ledger_record_hash(record: dict[str, Any]) -> str:
    material = {key: value for key, value in record.items() if key != "record_sha256"}
    return hashlib.sha256(_canonical_bytes(material)).hexdigest()


def read_panel_ledger(path: str | os.PathLike[str] | None = None) -> list[dict[str, Any]]:
    """Read and validate the append-only, hash-chained panel verdict ledger."""
    ledger = Path(path) if path is not None else _ledger_path()
    if not ledger.exists():
        return []
    records: list[dict[str, Any]] = []
    previous: str | None = None
    for line_number, line in enumerate(ledger.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            raise ValueError(f"blank panel ledger line {line_number}")
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid panel ledger JSON at line {line_number}: {exc}") from exc
        if not isinstance(record, dict):
            raise ValueError(f"panel ledger line {line_number} is not an object")
        if record.get("previous_record_sha256") != previous:
            raise ValueError(f"panel ledger chain mismatch at line {line_number}")
        observed = record.get("record_sha256")
        if not isinstance(observed, str) or observed != _ledger_record_hash(record):
            raise ValueError(f"panel ledger record hash mismatch at line {line_number}")
        records.append(record)
        previous = observed
    return records


def _pid_is_alive(pid: int) -> bool | None:
    """Return process liveness, or None when the OS cannot prove either state."""
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        import ctypes

        process_query_limited_information = 0x1000
        still_active = 259
        error_access_denied = 5
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return None if ctypes.get_last_error() == error_access_denied else False
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return None
            return exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return None
    return True


def _panel_lock_owner_alive(lock_path: Path) -> bool | None:
    try:
        owner_text = lock_path.read_text(encoding="ascii").strip()
        return _pid_is_alive(int(owner_text))
    except (FileNotFoundError, OSError, UnicodeError, ValueError):
        # An empty/corrupt lock may be left if the creator crashes before it
        # writes its PID. Age still has to exceed the stale threshold below.
        return False


def _recover_stale_panel_lock(lock_path: Path) -> bool:
    """Quarantine an old lock only when its recorded owner is provably dead."""
    recovery_path = lock_path.with_name(lock_path.name + ".recovery")
    recovery_descriptor: int | None = None
    try:
        try:
            recovery_descriptor = os.open(
                recovery_path,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                0o600,
            )
        except FileExistsError:
            try:
                recovery_age = time.time() - recovery_path.stat().st_mtime
            except FileNotFoundError:
                return False
            if recovery_age <= PANEL_LEDGER_STALE_SECONDS:
                return False
            recovery_stale = recovery_path.with_name(
                recovery_path.name + ".stale-" + uuid.uuid4().hex
            )
            try:
                os.replace(recovery_path, recovery_stale)
            except FileNotFoundError:
                return False
            try:
                recovery_stale.unlink()
            except FileNotFoundError:
                pass
            try:
                recovery_descriptor = os.open(
                    recovery_path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                )
            except FileExistsError:
                return False

        try:
            age = time.time() - lock_path.stat().st_mtime
        except FileNotFoundError:
            return True
        if age <= PANEL_LEDGER_STALE_SECONDS:
            return False
        owner_alive = _panel_lock_owner_alive(lock_path)
        if owner_alive is not False and age <= PANEL_LEDGER_HARD_STALE_SECONDS:
            return False
        stale_path = lock_path.with_name(lock_path.name + ".stale-" + uuid.uuid4().hex)
        try:
            os.replace(lock_path, stale_path)
        except FileNotFoundError:
            return True
        try:
            stale_path.unlink()
        except FileNotFoundError:
            pass
        return True
    finally:
        if recovery_descriptor is not None:
            os.close(recovery_descriptor)
            try:
                recovery_path.unlink()
            except FileNotFoundError:
                pass


def _append_panel_ledger(event: dict[str, Any], *, path: Path | None = None) -> dict[str, Any]:
    ledger = path or _ledger_path()
    ledger.parent.mkdir(parents=True, exist_ok=True)
    lock_path = ledger.with_name(ledger.name + ".lock")
    deadline = time.monotonic() + PANEL_LEDGER_LOCK_TIMEOUT_SECONDS
    descriptor: int | None = None
    while descriptor is None:
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if _recover_stale_panel_lock(lock_path):
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError(f"timed out acquiring panel ledger lock: {lock_path}")
            time.sleep(0.05)
    try:
        os.write(descriptor, f"{os.getpid()}\n".encode("ascii"))
        os.close(descriptor)
        descriptor = None
        prior = read_panel_ledger(ledger)
        record = dict(event)
        record.setdefault("ledger_schema_version", 1)
        record.setdefault("event_id", "pe-" + uuid.uuid4().hex)
        record.setdefault("created_at", utc_now_iso())
        record["previous_record_sha256"] = prior[-1]["record_sha256"] if prior else None
        record["record_sha256"] = _ledger_record_hash(record)
        line = _canonical_bytes(record) + b"\n"
        append_fd = os.open(ledger, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            os.write(append_fd, line)
            os.fsync(append_fd)
        finally:
            os.close(append_fd)
        return record
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


def _references_exact_id(text: str, identifier: str) -> bool:
    boundary = r"A-Za-z0-9_-"
    return re.search(
        rf"(?<![{boundary}]){re.escape(identifier)}(?![{boundary}])",
        text,
    ) is not None


def _parse_aware_timestamp(value: Any, *, label: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} has no valid created_at timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} has no valid created_at timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{label} created_at timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def record_panel_verdict(
    panel_id: str,
    finding_id: str,
    disposition: str,
    *,
    rationale: str,
    evidence_ids: list[str],
    verifier: str,
) -> dict[str, Any]:
    """Append a provenance-bearing finding disposition; existing rows never change."""
    if not isinstance(panel_id, str) or not panel_id.strip():
        raise ValueError("panel_id must be non-empty")
    if not isinstance(finding_id, str) or not finding_id.strip():
        raise ValueError("finding_id must be non-empty")
    if disposition not in _PANEL_DISPOSITIONS:
        raise ValueError(f"disposition must be one of {sorted(_PANEL_DISPOSITIONS)}")
    if disposition != "open" and (not rationale.strip() or not verifier.strip() or not evidence_ids):
        raise ValueError("closed dispositions require rationale, verifier, and evidence_ids")
    if not all(isinstance(item, str) and item.strip() for item in evidence_ids):
        raise ValueError("evidence_ids must contain non-empty strings")
    runs = [
        record for record in read_panel_ledger()
        if record.get("record_type") == "panel_run" and record.get("panel_id") == panel_id
    ]
    if not runs:
        raise ValueError(f"unknown panel_id: {panel_id}")
    panel_run = runs[-1]
    if finding_id not in panel_run.get("finding_ids", []):
        raise ValueError(f"finding_id {finding_id!r} does not belong to panel {panel_id!r}")

    evidence_records: list[dict[str, Any]] = []
    database = harness_dir() / "evidence.db"
    if disposition != "open":
        if len(set(evidence_ids)) != len(evidence_ids):
            raise ValueError("closed dispositions require distinct evidence IDs")
        if not database.is_file():
            raise ValueError("evidence ledger is unavailable")
        placeholders = ",".join("?" for _ in evidence_ids)
        uri = database.resolve().as_uri() + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        try:
            rows = connection.execute(
                "SELECT id, status, invalidated_at, claim, notes, verifier, created_at, artifact_paths "
                f"FROM evidence WHERE id IN ({placeholders})",
                evidence_ids,
            ).fetchall()
        finally:
            connection.close()
        by_id = {row[0]: row for row in rows}
        live_verified = {
            evidence_id for evidence_id, row in by_id.items()
            if row[1] == "verified" and row[2] is None and isinstance(row[5], str) and row[5].strip()
        }
        if live_verified != set(evidence_ids):
            raise ValueError("closed dispositions require existing live verified evidence IDs")
        panel_created_at = panel_run.get("created_at")
        panel_created = _parse_aware_timestamp(panel_created_at, label="panel run")
        for evidence_id in evidence_ids:
            row = by_id[evidence_id]
            claim = row[3] or ""
            notes = row[4] or ""
            artifact_paths_raw = row[7] or "[]"
            linkage_text = "\n".join((str(claim), str(notes), str(artifact_paths_raw)))
            if not _references_exact_id(linkage_text, finding_id):
                raise ValueError(
                    f"evidence {evidence_id!r} must reference the finding_id"
                )
            created_at = row[6]
            evidence_created = _parse_aware_timestamp(
                created_at, label=f"evidence {evidence_id!r}"
            )
            if evidence_created < panel_created:
                raise ValueError(
                    f"evidence {evidence_id!r} must be created at or after the panel run"
                )
            try:
                artifact_paths = json.loads(artifact_paths_raw)
            except (TypeError, json.JSONDecodeError) as exc:
                raise ValueError(f"evidence {evidence_id!r} must cite existing artifact files") from exc
            if not isinstance(artifact_paths, list) or not artifact_paths or not all(
                isinstance(item, str) and item for item in artifact_paths
            ):
                raise ValueError(f"evidence {evidence_id!r} must cite existing artifact files")
            repository = repo_root().resolve()
            for item in artifact_paths:
                candidate = Path(item)
                if not candidate.is_absolute():
                    candidate = repository / candidate
                try:
                    resolved = candidate.resolve(strict=True)
                    resolved.relative_to(repository)
                except (OSError, RuntimeError, ValueError) as exc:
                    raise ValueError(f"evidence {evidence_id!r} must cite existing artifact files") from exc
                if not resolved.is_file():
                    raise ValueError(f"evidence {evidence_id!r} must cite existing artifact files")
            evidence_records.append({
                "id": evidence_id,
                "claim": claim,
                "verifier": row[5],
                "created_at": created_at,
                "artifact_paths": artifact_paths,
            })
    return _append_panel_ledger({
        "record_type": "finding_disposition", "panel_id": panel_id,
        "finding_id": finding_id, "disposition": disposition,
        "rationale": rationale.strip(), "evidence_ids": evidence_ids,
        "evidence_records": evidence_records, "verifier": verifier.strip(),
    })


def _snapshot_fingerprint(root: Path) -> str:
    entries: list[bytes] = []
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        dirnames[:] = sorted(dirnames)
        for name in sorted(filenames):
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            if relative == ".git":
                continue
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise RuntimeError(f"snapshot still contains symlink: {relative}")
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError(f"snapshot contains non-regular entry: {relative}")
            entries.append(relative.encode("utf-8") + b"\0" +
                           hashlib.sha256(path.read_bytes()).digest() + b"\0" +
                           str(stat.S_IMODE(info.st_mode)).encode("ascii"))
    return hashlib.sha256(b"\n".join(entries)).hexdigest()


def _neutralize_snapshot_links(root: Path) -> int:
    """Replace snapshot links with inert regular files containing only link text."""
    count = 0
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in list(dirnames):
            candidate = current_path / name
            if candidate.is_symlink():
                dirnames.remove(name)
                target = os.readlink(candidate)
                candidate.unlink()
                candidate.write_text(f"SYMLINK NOT FOLLOWED: {target}\n", encoding="utf-8")
                count += 1
        for name in filenames:
            candidate = current_path / name
            if candidate.is_symlink():
                target = os.readlink(candidate)
                candidate.unlink()
                candidate.write_text(f"SYMLINK NOT FOLLOWED: {target}\n", encoding="utf-8")
                count += 1
    return count


def review_panel(
    question: str = "",
    *,
    base: str | None = None,
    head: str = "HEAD",
    tools: tuple[str, ...] = ("claude", "codex"),
    timeout_seconds: int | None = None,
    extra_context: str = "",
) -> dict[str, Any]:
    """Run independent Claude and Codex workstreams concurrently on one freeze.

    Each process receives the same prompt and a private copy of the same
    detached worktree, and cannot observe the other process or its response.
    A partial/error panel is never represented as a clean review.
    """
    if not isinstance(tools, tuple) or len(tools) < 2 or len(set(tools)) != len(tools):
        raise ValueError("tools must be a tuple of at least two distinct critic names")
    if any(tool not in _ADAPTERS for tool in tools):
        raise ValueError(f"unsupported panel tools: {tools!r}")
    root = repo_root()
    config = load_config().get("critic", {})
    timeout_seconds = timeout_seconds or int(config.get("timeout_seconds", 900))
    if timeout_seconds < 1:
        raise ValueError("timeout_seconds must be positive")
    if base is None:
        for candidate in ("origin/main", "origin/master", "main", "master"):
            if _git(["rev-parse", "--verify", "--quiet", candidate], root).returncode == 0:
                base = candidate
                break
    if base is None:
        return {"status": "error", "verdict": "inconclusive",
                "reason": "could not resolve a base ref; pass base= explicitly"}
    base_proc = _git(["rev-parse", f"{base}^{{commit}}"], root)
    if base_proc.returncode != 0:
        return {"status": "error", "verdict": "inconclusive",
                "reason": f"cannot resolve base {base!r}: {base_proc.stderr.strip()}"}
    base_sha = base_proc.stdout.strip()
    head_proc = _git(["rev-parse", f"{head}^{{commit}}"], root)
    if head_proc.returncode != 0:
        return {"status": "error", "verdict": "inconclusive",
                "reason": f"cannot resolve head {head!r}: {head_proc.stderr.strip()}"}
    head_sha = head_proc.stdout.strip()
    diff_proc = _git(["diff", f"{base_sha}...{head_sha}"], root, timeout=300)
    if diff_proc.returncode != 0:
        return {"status": "error", "verdict": "inconclusive",
                "reason": f"git diff failed: {(diff_proc.stderr or '').strip()}"}

    out_dir = harness_dir() / "critic"
    out_dir.mkdir(parents=True, exist_ok=True)
    panel_id = "panel-" + utc_now_iso().replace(":", "").replace("+", "Z") + "-" + uuid.uuid4().hex[:8]
    ledger_event_id = "panel-run:" + panel_id
    panel_path = out_dir / f"{panel_id}-verdict.json"
    prompt = "\n\n".join(part for part in [
        (question or DEFAULT_QUESTION).strip(), extra_context.strip(),
        f"Diff range: {base_sha[:12]}...{head_sha[:12]}",
        "You are one independent panel workstream. Do not infer or predict the other critic's response.",
        _FINDINGS_INSTRUCTIONS,
    ] if part)

    neutralized_links = 0
    if not (diff_proc.stdout or "").strip():
        workstreams = {tool: {"status": "done", "tool": tool, "findings": [], "counts": {},
                              "note": "empty diff - critic not launched"} for tool in tools}
        status = "done"
    else:
        temp_root = Path(tempfile.mkdtemp(prefix="prime-critic-panel-"))
        snapshot = temp_root / "frozen"
        try:
            add = _git(["worktree", "add", "--detach", str(snapshot), head_sha], root, timeout=300)
            if add.returncode != 0:
                return {"status": "error", "verdict": "inconclusive",
                        "reason": f"git worktree add failed: {add.stderr.strip()}"}
            (snapshot / "REVIEW_DIFF.patch").write_text(diff_proc.stdout, encoding="utf-8")
            neutralized_links = _neutralize_snapshot_links(snapshot)
            workdirs: dict[str, Path] = {}
            for tool in tools:
                destination = temp_root / f"workstream-{tool}"
                shutil.copytree(snapshot, destination, symlinks=True)
                git_pointer = destination / ".git"
                if git_pointer.is_file():
                    git_pointer.unlink()
                workdirs[tool] = destination
            workstreams = {}
            with ThreadPoolExecutor(max_workers=len(tools), thread_name_prefix="critic-panel") as executor:
                futures = {
                    executor.submit(_panel_workstream, tool, prompt, workdirs[tool], out_dir,
                                    panel_id, timeout_seconds, base, base_sha, head_sha): tool
                    for tool in tools
                }
                for future in as_completed(futures):
                    tool = futures[future]
                    try:
                        workstreams[tool] = future.result()
                    except Exception as exc:
                        workstreams[tool] = {"status": "error", "tool": tool,
                                              "reason": f"workstream crashed: {type(exc).__name__}: {exc}"}
            done_count = sum(stream.get("status") == "done" for stream in workstreams.values())
            status = "done" if done_count == len(tools) else ("partial" if done_count else "error")
        except Exception as exc:
            return {"status": "error", "verdict": "inconclusive",
                    "reason": f"panel setup/execution failed: {type(exc).__name__}: {exc}"}
        finally:
            _git(["worktree", "remove", "--force", str(snapshot)], root, timeout=120)
            shutil.rmtree(temp_root, ignore_errors=True)
            _git(["worktree", "prune"], root, timeout=60)

    normalized, disagreements = _normalize_panel_findings(workstreams, list(tools))
    counts = _severity_counts(normalized)
    if status != "done":
        verdict = "inconclusive"
    elif counts.get("critical", 0) or counts.get("major", 0):
        verdict = "action_required"
    elif normalized:
        verdict = "review_required"
    else:
        verdict = "clean"
    report = {
        "source": "external-critic:panel", "schema_version": 1,
        "panel_id": panel_id, "status": status, "verdict": verdict,
        "base": base, "base_sha": base_sha, "head": head_sha, "question": question or DEFAULT_QUESTION,
        "required_tools": list(tools), "neutralized_symlinks": neutralized_links,
        "workstreams": {tool: workstreams[tool] for tool in sorted(workstreams)},
        "findings": normalized, "disagreements": disagreements, "counts": counts,
        "ledger_path": str(_ledger_path()), "ledger_event_id": ledger_event_id,
        "created_at": utc_now_iso(),
    }
    atomic_write_json(panel_path, report)
    report_sha = hashlib.sha256(panel_path.read_bytes()).hexdigest()
    ledger_record = _append_panel_ledger({
        "record_type": "panel_run", "event_id": ledger_event_id,
        "panel_id": panel_id, "status": status, "verdict": verdict,
        "base": base, "base_sha": base_sha, "head": head_sha, "tools": list(tools), "counts": counts,
        "finding_ids": [item["finding_id"] for item in normalized],
        "panel_path": str(panel_path), "panel_sha256": report_sha,
    })
    return {
        **report,
        "panel_path": str(panel_path), "panel_sha256": report_sha,
        "ledger_record_sha256": ledger_record["record_sha256"],
    }

def run(question: str = "") -> dict[str, Any]:
    """Module entry point: review the current branch against the default base."""
    return review(question)
