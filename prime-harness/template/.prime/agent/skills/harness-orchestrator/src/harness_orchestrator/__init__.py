"""harness-orchestrator â€” disciplined delegation for Prime Agent.

Wraps `rlm.run(...)` with the reliability policy this project mandates:
typed task state that survives kernel loss, an explicit admission rule for
every child, file-based structured output contracts, duplicate-task
prevention, budget awareness via the persistent goal, and snapshot/diff
tooling for governed Continual Harness refinement.

Verified against Prime Agent v0.7.0 behavior:
- `rlm.run(prompt, name=..., model=...)` are the ONLY supported kwargs; it
  returns an admission handle, never the child's answer.
- Child results come back only via files the child writes or agent messages.
- Depth is host-enforced (default max depth 1); RLM_DEPTH env is advisory.
- `goal.get()` exposes `remaining_tokens` â€” the only budget signal readable
  from the kernel.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import stat
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from ._common import (
    NotInKernel,
    atomic_write_json,
    current_commit,
    harness_dir,
    load_config,
    maybe_await,
    read_json,
    repo_root,
    require_kernel_module,
    utc_now_iso,
)

__all__ = [
    "TaskState",
    "load_task_state",
    "save_task_state",
    "new_task",
    "admit",
    "spawn",
    "collect",
    "pending",
    "followup",
    "reconcile",
    "forget",
    "budget_status",
    "roster",
    "harness_snapshot",
    "harness_diff",
    "coverage_disposition_assumptions",
    "completion_check",
    "SelfcheckError",
    "selfcheck",
    "run",
]

RESULT_STATUSES = ("pass", "fail", "counterexample_found", "inconclusive", "done", "error")
_CHILD_NAME_MAX = 64  # RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH in the host


# ---------------------------------------------------------------------------
# Typed task state (compact working state + identifiers into durable stores)
# ---------------------------------------------------------------------------


@dataclass
class TaskState:
    task_id: str
    objective: str
    base_commit: str | None = None
    working_branch: str | None = None
    assumptions: dict[str, Any] = field(default_factory=dict)
    unresolved_claims: list[str] = field(default_factory=list)
    evidence_ids: list[str] = field(default_factory=list)
    active_child_names: list[str] = field(default_factory=list)
    quality_gate_status: dict[str, str] = field(default_factory=dict)
    next_actions: list[str] = field(default_factory=list)
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)


def _state_path() -> Path:
    return harness_dir() / "task-state.json"


def load_task_state() -> TaskState | None:
    data = read_json(_state_path())
    if not isinstance(data, dict):
        return None
    known = {f for f in TaskState.__dataclass_fields__}
    return TaskState(**{k: v for k, v in data.items() if k in known})


def _commit_is_ancestor(ancestor: str, descendant: str) -> bool:
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", ancestor) or not re.fullmatch(r"[0-9a-fA-F]{40,64}", descendant):
        return False
    try:
        process = subprocess.run(
            ["git", "merge-base", "--is-ancestor", ancestor, descendant],
            cwd=repo_root(), capture_output=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return process.returncode == 0


def save_task_state(state: TaskState) -> Path:
    state.updated_at = utc_now_iso()
    live_head = current_commit()
    observed = state.assumptions.get("highest_observed_head")
    if isinstance(live_head, str) and live_head:
        if not isinstance(observed, str) or not observed:
            state.assumptions["highest_observed_head"] = live_head
        elif _commit_is_ancestor(observed, live_head):
            state.assumptions["highest_observed_head"] = live_head
        # A rewind/divergence deliberately leaves the prior high-water mark in
        # place so completion scoring can detect the regression.
    path = _state_path()
    atomic_write_json(path, asdict(state))
    return path


def new_task(task_id: str, objective: str, *, working_branch: str | None = None) -> TaskState:
    """Create and persist a fresh TaskState pinned to the current commit."""
    state = TaskState(
        task_id=task_id,
        objective=objective,
        base_commit=current_commit(),
        working_branch=working_branch,
    )
    save_task_state(state)
    return state


# ---------------------------------------------------------------------------
# Child registry (file-backed; survives kernel restarts and compaction)
# ---------------------------------------------------------------------------


def _registry_path() -> Path:
    return harness_dir() / "children.json"


def _load_registry() -> dict[str, dict[str, Any]]:
    data = read_json(_registry_path(), default={})
    return data if isinstance(data, dict) else {}


def _save_registry(registry: dict[str, dict[str, Any]]) -> None:
    atomic_write_json(_registry_path(), registry)


def _fingerprint(role: str, task: str) -> str:
    normalized = re.sub(r"\s+", " ", task.strip().lower())
    return hashlib.sha256(f"{role}\n{normalized}".encode()).hexdigest()[:16]


def _allocate_name(role: str, registry: dict[str, Any]) -> str:
    base = re.sub(r"[^a-z0-9-]+", "-", role.lower()).strip("-") or "worker"
    for index in range(1, 1000):
        name = f"{base}-{index:03d}"[:_CHILD_NAME_MAX]
        if name not in registry:
            return name
    raise RuntimeError(f"Could not allocate a unique child name for role {role!r}")


def _is_active(entry: dict[str, Any]) -> bool:
    """Active = spawned, no result file yet, not marked dead."""
    return not Path(entry["result_path"]).exists() and not entry.get("dead_at")


async def reconcile() -> dict[str, Any]:
    """Mark registry entries whose children died without reporting.

    Uses rlm.list_subagents() (kernel-only; best-effort elsewhere). A child is
    dead when it has no result file and its session status is completed/error,
    or it is absent from the subagent registry entirely (prior session, or
    deleted). Dead entries stop counting against the active-children cap and
    stop blocking duplicate-task respawns.
    """
    registry = _load_registry()
    marked: list[str] = []
    try:
        rlm = require_kernel_module("rlm")
        listed = await maybe_await(rlm.list_subagents())
        subagents = {}
        for subagent in listed:
            # Prime Agent v0.7.1 exposes ``session_name``. Older test doubles and
            # early docs used ``name``; accept both, but never silently treat an
            # attribute mismatch as an unavailable host API.
            name = getattr(subagent, "session_name", None) or getattr(subagent, "name", None)
            if not isinstance(name, str) or not name:
                raise TypeError(
                    "rlm.list_subagents() item lacks a non-empty session_name/name: "
                    f"{subagent!r}"
                )
            subagents[name] = getattr(subagent, "status", None)
    except Exception as exc:
        return {
            "marked_dead": [],
            "note": f"rlm.list_subagents unavailable; nothing reconciled: {type(exc).__name__}: {exc}",
        }
    changed = False
    for name, entry in registry.items():
        if not _is_active(entry):
            continue
        status = subagents.get(name)
        if status is None or status in ("completed", "error"):
            entry["dead_at"] = utc_now_iso()
            entry["dead_reason"] = (
                "absent from rlm.list_subagents()" if status is None
                else f"session {status} but no result file written (contract violation or crash)"
            )
            marked.append(name)
            changed = True
    if changed:
        _save_registry(registry)
    return {"marked_dead": marked}


def forget(name: str) -> dict[str, Any]:
    """File-only recovery hammer: mark a child dead regardless of kernel state
    (usable outside the kernel too). It stops blocking admission immediately."""
    registry = _load_registry()
    entry = registry.get(name)
    if entry is None:
        raise KeyError(f"unknown child {name!r}; known: {sorted(registry)}")
    entry["dead_at"] = utc_now_iso()
    entry["dead_reason"] = "manually forgotten"
    _save_registry(registry)
    return entry


# ---------------------------------------------------------------------------
# Admission policy
# ---------------------------------------------------------------------------


@dataclass
class Admission:
    admitted: bool
    reasons: list[str]

    def __bool__(self) -> bool:  # allows `if await admit(...):`
        return self.admitted


async def budget_status() -> dict[str, Any]:
    """Best-effort budget snapshot. Keys: goal, remaining_tokens, active_children."""
    out: dict[str, Any] = {
        "goal": None,
        "remaining_tokens": None,
        "budget_authority_available": False,
    }
    try:
        goal_mod = require_kernel_module("goal")
        info = await maybe_await(goal_mod.get())
        if isinstance(info, dict) and {"goal", "remaining_tokens"} <= set(info):
            out["goal"] = info.get("goal")
            out["remaining_tokens"] = info.get("remaining_tokens")
            out["budget_authority_available"] = True
    except Exception:  # budget introspection must never crash the caller
        pass
    registry = _load_registry()
    try:
        await reconcile()
        registry = _load_registry()
    except Exception:
        pass
    out["active_children"] = [name for name, entry in registry.items() if _is_active(entry)]
    return out


async def admit(
    role: str,
    task: str,
    *,
    independent_subproblem: bool,
    objective_verifier_available: bool,
    expected_minutes: float = 10.0,
) -> Admission:
    """Decide whether spawning a child is justified.

    Encodes the project recursion policy: children are for independent,
    verifiable work of real size â€” never for trivial edits or work whose
    every branch depends on the same unresolved premise.
    """
    config = load_config()
    reasons: list[str] = []

    if not independent_subproblem:
        reasons.append("not an independent subproblem â€” do it inline")
    if not objective_verifier_available:
        reasons.append("no objective verifier â€” inline work plus sci_verify is safer")
    if expected_minutes < 5:
        reasons.append(f"expected_minutes={expected_minutes} < 5 â€” delegation overhead exceeds the task")

    depth = os.environ.get("RLM_DEPTH", "0")
    max_depth = os.environ.get("RLM_MAX_DEPTH")
    if max_depth is not None and depth.isdigit() and max_depth.isdigit() and int(depth) >= int(max_depth):
        reasons.append(
            f"RLM depth {depth} >= max {max_depth} (advisory env check; the host enforces the real limit)"
        )

    try:
        await reconcile()  # best-effort: outside the kernel this is a no-op
    except Exception:
        pass
    registry = _load_registry()
    fingerprint = _fingerprint(role, task)
    for name, entry in registry.items():
        if entry.get("fingerprint") != fingerprint or entry.get("dead_at"):
            continue  # dead duplicates may be respawned
        result_path = Path(entry["result_path"])
        if not result_path.exists():
            reasons.append(
                f"duplicate of child {name!r} (still pending) â€” follow up with "
                f"followup({name!r}, ...) or forget({name!r}) instead of respawning"
            )
            continue
        try:
            result = _parse_result_text(result_path.read_text(encoding="utf-8"))
            status = result.get("status")
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            reasons.append(
                f"duplicate of child {name!r} whose result file violates the contract â€” "
                f"collect({name!r}) surfaces the error; followup({name!r}, ...) to have it rewritten"
            )
            continue
        if status != "error":
            reasons.append(
                f"duplicate of child {name!r} (status={status!r}) â€” "
                f"collect({name!r}) or followup({name!r}, ...) instead of respawning"
            )

    active = [n for n, e in registry.items() if _is_active(e)]
    max_active = int(config.get("max_active_children", 6))
    if len(active) >= max_active:
        reasons.append(f"{len(active)} children already active (cap {max_active}) â€” collect results, "
                       f"or reconcile()/forget() dead ones")

    budget = await budget_status()
    remaining = budget.get("remaining_tokens")
    floor = int(config.get("min_goal_tokens_to_spawn", 20000))
    if budget.get("budget_authority_available") is not True:
        reasons.append("goal budget authority unavailable â€” delegation fails closed")
    elif isinstance(remaining, (int, float)) and remaining < floor:
        reasons.append(f"goal budget remaining {remaining} < spawn floor {floor}")

    return Admission(admitted=not reasons, reasons=reasons)


# ---------------------------------------------------------------------------
# Roster + spawning
# ---------------------------------------------------------------------------


def roster() -> dict[str, dict[str, Any]]:
    """Load harness/roster.yaml â†’ {role: spec}. Empty dict when absent."""
    path = repo_root() / "harness" / "roster.yaml"
    if not path.is_file():
        return {}
    import yaml  # pre-installed in the Prime Agent kernel venv; declared in pyproject

    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    specs = data.get("roster", data) if isinstance(data, dict) else {}
    return specs if isinstance(specs, dict) else {}


def _contract_block(result_path: Path, summary_max: int) -> str:
    schema = (
        '{"task": "<restated task>", "status": "pass|fail|counterexample_found|inconclusive|done|error", '
        '"summary": "<=1200 chars", "assumptions": ["..."], "evidence": {}, '
        '"counterexamples": [], "artifacts": ["<paths>"], "recommended_action": "..."}'
    )
    return (
        "## Output contract (MANDATORY)\n"
        f"1. Write your final structured result as a single JSON object to this exact path:\n"
        f"   {result_path}\n"
        f"   Use this schema: {schema}\n"
        f"   Never convert 'inconclusive' into 'pass'. Record seeds for anything randomized.\n"
        f"2. After writing the file, if `agent_message` is available, send your parent a summary of at most "
        f"{summary_max} characters:  await agent_message.send(\"<summary>\", receiver_role=\"parent\")\n"
        "3. Store bulky output (logs, tables, plots) as files under artifacts/ and reference their paths; "
        "keep the JSON compact.\n"
        "4. You may NOT: mark the parent goal complete, modify files outside your assigned scope, "
        "edit harness state, or spawn further subagents unless your task explicitly authorizes it.\n"
        "5. If blocked, still write the JSON with status \"error\" and describe exactly what blocked you."
    )


async def spawn(
    role: str,
    task: str,
    *,
    context: dict[str, Any] | None = None,
    model: str | None = None,
    name: str | None = None,
    skip_admission: bool = False,
) -> dict[str, Any]:
    """Spawn a roster specialist with the standard output contract.

    Returns {name, result_path, handle} on success. Raises RuntimeError with
    the admission reasons when the spawn is not admitted (pass
    skip_admission=True only with an explicit justification in the transcript).
    """
    config = load_config()
    specs = roster()
    spec = specs.get(role, {})

    if not skip_admission:
        decision = await admit(
            role,
            task,
            independent_subproblem=True,
            objective_verifier_available=bool(spec.get("verifier", True)),
        )
        if not decision:
            raise RuntimeError("spawn not admitted: " + "; ".join(decision.reasons))

    # Reserve the name and registry slot BEFORE any await: concurrent spawns
    # then allocate distinct names, and a kernel death mid-spawn leaves a
    # visible "spawning" entry instead of an untracked child.
    registry = _load_registry()
    child_name = name or _allocate_name(role, registry)
    if len(child_name) > _CHILD_NAME_MAX:
        raise ValueError(f"child name {child_name!r} exceeds {_CHILD_NAME_MAX} chars")
    if child_name in registry:
        raise ValueError(f"child name {child_name!r} already in the registry")

    results_dir = harness_dir() / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    result_path = (results_dir / f"{child_name}.json").resolve()

    registry[child_name] = {
        "role": role,
        "status": "spawning",
        "fingerprint": _fingerprint(role, task),
        "task_preview": task.strip()[:300],
        "result_path": str(result_path),
        "reserved_at": utc_now_iso(),
    }
    _save_registry(registry)

    state = load_task_state()
    commit = current_commit()
    header_lines = [f"You are the retained specialist `{child_name}` (role: {role}) for this project."]
    if spec.get("purpose"):
        header_lines.append(f"Role purpose: {spec['purpose']}")
    if spec.get("instructions"):
        header_lines.append(str(spec["instructions"]).strip())
    if state:
        header_lines.append(
            f"Parent task: {state.task_id} â€” {state.objective} "
            f"(base commit {state.base_commit}, branch {state.working_branch})"
        )
    if commit:
        header_lines.append(f"Current commit at spawn time: {commit}")
    if context:
        header_lines.append("Context (JSON):\n" + json.dumps(context, indent=2, default=str))

    prompt = (
        "\n\n".join(header_lines)
        + "\n\n## Task\n"
        + task.strip()
        + "\n\n"
        + _contract_block(result_path, int(config.get("child_summary_max_chars", 600)))
    )

    kwargs: dict[str, Any] = {"name": child_name}
    model_selector = model or spec.get("model")
    if model_selector:
        kwargs["model"] = model_selector
    try:
        rlm = require_kernel_module("rlm")
        handle = await maybe_await(rlm.run(prompt, **kwargs))
    except BaseException:
        # release the reservation; reload first â€” others may have written
        registry = _load_registry()
        registry.pop(child_name, None)
        _save_registry(registry)
        raise

    # Finalize: reload-modify-save with no await in between.
    registry = _load_registry()
    entry = registry.setdefault(child_name, {"role": role, "result_path": str(result_path),
                                             "fingerprint": _fingerprint(role, task),
                                             "task_preview": task.strip()[:300]})
    entry.update({"status": "running", "spawned_at": utc_now_iso(),
                  "commit": commit, "model": model_selector})
    _save_registry(registry)

    fresh_state = load_task_state()
    if fresh_state is not None and child_name not in fresh_state.active_child_names:
        fresh_state.active_child_names.append(child_name)
        save_task_state(fresh_state)

    return {"name": child_name, "result_path": str(result_path), "handle": handle}


# ---------------------------------------------------------------------------
# Result collection
# ---------------------------------------------------------------------------


def _parse_result_text(text: str) -> dict[str, Any]:
    text = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, flags=re.DOTALL)
    if fence:
        text = fence.group(1)
    return json.loads(text)


def collect(name: str) -> dict[str, Any]:
    """Read and validate a child's structured result.

    Raises FileNotFoundError while the result is still pending and ValueError
    when the child violated the output contract (both messages tell the model
    what to do next).
    """
    registry = _load_registry()
    entry = registry.get(name)
    if entry is None:
        raise KeyError(f"unknown child {name!r}; known: {sorted(registry)}")
    path = Path(entry["result_path"])
    if not path.exists():
        raise FileNotFoundError(
            f"child {name!r} has not written {path} yet â€” check rlm.list_subagents() status, "
            f"or follow up with followup({name!r}, 'status?')"
        )
    try:
        result = _parse_result_text(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError(
            f"child {name!r} wrote invalid JSON to {path}: {exc}. "
            f"Ask it to rewrite the file per the output contract."
        ) from exc
    missing = [k for k in ("task", "status", "summary") if k not in result]
    if missing:
        raise ValueError(f"child {name!r} result is missing required keys {missing} (contract violation)")
    if result["status"] not in RESULT_STATUSES:
        raise ValueError(
            f"child {name!r} used status {result['status']!r}; allowed: {RESULT_STATUSES}"
        )
    state = load_task_state()
    if state is not None and name in state.active_child_names:
        state.active_child_names.remove(name)
        save_task_state(state)
    return result


def pending() -> dict[str, Any]:
    """Children spawned through this skill whose result files do not exist yet
    (excluding ones marked dead â€” run `await reconcile()` to refresh)."""
    registry = _load_registry()
    return {
        name: {"role": entry.get("role"), "spawned_at": entry.get("spawned_at")}
        for name, entry in registry.items()
        if _is_active(entry)
    }


async def followup(name: str, message: str) -> Any:
    """Message a retained child by name (steering delivery; never blocks)."""
    agent_message = require_kernel_module("agent_message")
    return await maybe_await(agent_message.send(message, receiver_role="child", receiver_name=name))


# ---------------------------------------------------------------------------
# Continual Harness governance: snapshot + diff around /refine
# ---------------------------------------------------------------------------


def _harness_state_paths() -> dict[str, Path | None]:
    local_dir = os.environ.get("RLM_HARNESS_STATE_DIR")
    global_dir = os.environ.get("RLM_GLOBAL_HARNESS_STATE_DIR")
    session_dir = os.environ.get("RLM_SESSION_DIR")
    local = Path(local_dir) / "harness_state.json" if local_dir else None
    if local is None and session_dir:
        local = Path(session_dir) / "harness" / "harness_state.json"
    global_ = Path(global_dir) / "harness_state.json" if global_dir else None
    return {"local": local, "global": global_}


def harness_snapshot(label: str = "manual") -> dict[str, Any]:
    """Copy the current local+global harness state into the snapshot archive.

    Take one BEFORE every refinement; harness_diff() then shows exactly what
    changed. Note the refinement id from the diff and record it â€” rolling back
    is a HUMAN action (`/refine rollback <id>` on a user surface; the kernel
    refine skill has no rollback parameter), so surface the id to the operator.
    """
    snap_root = harness_dir() / "harness-snapshots"
    stamp = utc_now_iso().replace(":", "").replace("+", "Z")
    label_slug = re.sub(r"[^a-z0-9-]+", "-", label.lower()).strip("-") or "snap"
    dest = snap_root / f"{stamp}-{label_slug}"
    dest.mkdir(parents=True, exist_ok=True)
    copied: dict[str, Any] = {"snapshot_dir": str(dest), "copied": {}}
    for scope, path in _harness_state_paths().items():
        if path is None or not path.is_file():
            copied["copied"][scope] = None
            continue
        data = read_json(path)
        atomic_write_json(dest / f"{scope}.json", data if data is not None else {})
        copied["copied"][scope] = str(path)
    return copied


def harness_diff() -> str:
    """Unified diff of current harness state vs the most recent snapshot."""
    import difflib

    snap_root = harness_dir() / "harness-snapshots"
    snapshots = sorted(snap_root.iterdir()) if snap_root.is_dir() else []
    if not snapshots:
        return "no snapshots yet â€” call harness_snapshot() before refining"
    latest = snapshots[-1]
    chunks: list[str] = []
    for scope, path in _harness_state_paths().items():
        old = read_json(latest / f"{scope}.json", default={})
        new = read_json(path, default={}) if path else {}
        old_text = json.dumps(old, indent=2, sort_keys=True, default=str).splitlines(keepends=True)
        new_text = json.dumps(new, indent=2, sort_keys=True, default=str).splitlines(keepends=True)
        diff = list(
            difflib.unified_diff(old_text, new_text, fromfile=f"{scope}@{latest.name}", tofile=f"{scope}@now")
        )
        if diff:
            chunks.append("".join(diff))
    return "\n".join(chunks) if chunks else "harness state unchanged since last snapshot"


# ---------------------------------------------------------------------------
# Live kernel compatibility self-check
# ---------------------------------------------------------------------------


def coverage_disposition_assumptions(directories: list[str], reason: str) -> dict[str, Any]:
    """Build the only accepted task-scoped coverage override metadata.

    The caller must record the returned assumptions through evidence_ledger.record
    with status="verified", claim_type="verification-coverage-disposition", and a
    non-empty independent verifier. This helper deliberately does not write or
    silently approve a disposition.
    """
    state = load_task_state()
    if state is None or not isinstance(state.base_commit, str) or not state.base_commit:
        raise RuntimeError("coverage disposition requires task state with a pinned base commit")
    if not isinstance(directories, list) or not directories or len(directories) > 128:
        raise ValueError("directories must be a non-empty list of at most 128 top-level names")
    normalized: list[str] = []
    for directory in directories:
        if (
            not isinstance(directory, str) or not directory or len(directory) > 128
            or directory not in {"."} and re.fullmatch(r"[A-Za-z0-9._-]+", directory) is None
        ):
            raise ValueError("coverage directory must be '.' or a bounded top-level repository name")
        if directory not in normalized:
            normalized.append(directory)
    if not isinstance(reason, str) or len(reason.strip()) < 20:
        raise ValueError("coverage disposition reason must contain at least 20 characters")
    return {"verification_coverage": {
        "kind": "disposition",
        "directories": normalized,
        "base_commit": state.base_commit,
        "reason": reason.strip(),
    }}


def _persist_completion_status(state: TaskState, status: str, reasons: list[str], output: Path | None) -> None:
    state.quality_gate_status["completion_coverage"] = {
        "status": status,
        "reasons": reasons,
        "scorecard": str(output) if output else None,
        "checked_at": utc_now_iso(),
        "head": current_commit(),
    }
    save_task_state(state)


def _completion_path_is_safe(root: Path, path: Path) -> bool:
    try:
        relative = path.relative_to(root)
        current = root
        for part in relative.parts[:-1]:
            current = current / part
            if not os.path.lexists(current):
                continue
            info = current.stat(follow_symlinks=False)
            if (
                not stat.S_ISDIR(info.st_mode) or current.is_symlink()
                or bool(getattr(info, "st_file_attributes", 0) & 0x400)
            ):
                return False
        if os.path.lexists(path):
            info = path.stat(follow_symlinks=False)
            if (
                not stat.S_ISREG(info.st_mode) or path.is_symlink()
                or bool(getattr(info, "st_file_attributes", 0) & 0x400)
            ):
                return False
    except (OSError, ValueError):
        return False
    return True


def _stable_completion_json(path: Path) -> dict[str, Any]:
    before = path.stat(follow_symlinks=False)
    if (
        not stat.S_ISREG(before.st_mode) or path.is_symlink()
        or bool(getattr(before, "st_file_attributes", 0) & 0x400)
        or before.st_size > 8 * 1024 * 1024
    ):
        raise ValueError("missing, linked, or oversized output")
    with path.open("rb") as handle:
        opened = os.fstat(handle.fileno())
        raw = handle.read(8 * 1024 * 1024 + 1)
    after = path.stat(follow_symlinks=False)
    identity = lambda item: (item.st_dev, item.st_ino, item.st_mode, item.st_size, item.st_mtime_ns)
    if len(raw) > 8 * 1024 * 1024 or identity(before) != identity(opened) or identity(opened) != identity(after):
        raise ValueError("completion output changed during bounded read")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("output is not an object")
    return value


def completion_check(*, timeout_seconds: int = 240) -> dict[str, Any]:
    """Run the fail-closed final profile immediately before goal.complete()."""
    if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int) or not 1 <= timeout_seconds <= 600:
        raise ValueError("timeout_seconds must be an integer from 1 through 600")
    state = load_task_state()
    if state is None:
        return {"status": "fail", "reasons": ["task state is unavailable"], "scorecard": None}
    if state.unresolved_claims:
        reasons = [f"task state has {len(state.unresolved_claims)} unresolved claims"]
        _persist_completion_status(state, "fail", reasons, None)
        return {"status": "fail", "reasons": reasons, "scorecard": None}
    root = repo_root()
    script = root / "harness" / "verify.py"
    # The protected final profile owns this repository-relative output path;
    # configurable telemetry directories cannot redirect the completion proof.
    output = root / "artifacts" / "harness" / "completion-scorecard.json"
    reasons: list[str] = []
    initial_head = current_commit()
    if not isinstance(initial_head, str) or not initial_head:
        reasons.append("repository HEAD is unavailable before completion scoring")
    if script.is_symlink() or not script.is_file():
        reasons.append("harness/verify.py is missing or link-backed")
    if not _completion_path_is_safe(root, output):
        reasons.append("completion scorecard path is missing, non-regular, or link-backed")
    if reasons:
        _persist_completion_status(state, "fail", reasons, output)
        return {"status": "fail", "reasons": reasons, "scorecard": None}
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        if not _completion_path_is_safe(root, output):
            raise OSError("completion output parent became unsafe during creation")
        output.unlink(missing_ok=True)
        parent_before = output.parent.stat(follow_symlinks=False)
    except OSError as exc:
        reasons.append(f"stale completion scorecard cannot be removed: {type(exc).__name__}")
        _persist_completion_status(state, "fail", reasons, output)
        return {"status": "fail", "reasons": reasons, "scorecard": None}
    command = [sys.executable, "-S", str(script), "--profile", "final", "--json"]
    try:
        process = subprocess.run(
            command, cwd=root, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout_seconds,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        reasons.append(f"completion scorecard execution failed: {type(exc).__name__}")
        _persist_completion_status(state, "fail", reasons, output)
        return {"status": "fail", "reasons": reasons, "command": command, "scorecard": None}
    gate_verdict: dict[str, Any] | None = None
    for line in reversed((process.stdout or "").splitlines()):
        if line.startswith("GATE_RESULT "):
            try:
                candidate_verdict = json.loads(line[len("GATE_RESULT "):])
                if isinstance(candidate_verdict, dict):
                    gate_verdict = candidate_verdict
            except json.JSONDecodeError:
                pass
            break
    expected_gate_keys = {
        "status", "profile", "passed", "failed", "skipped", "log_dir",
        "applicable_checks", "min_applicable_checks", "vacuous", "vacuous_allowed",
    }
    if (
        gate_verdict is None or set(gate_verdict) != expected_gate_keys
        or gate_verdict.get("status") != "pass"
        or gate_verdict.get("profile") != "final"
        or gate_verdict.get("vacuous") is not False
        or gate_verdict.get("vacuous_allowed") is not False
        or gate_verdict.get("applicable_checks") != 1
        or gate_verdict.get("min_applicable_checks") != 1
        or gate_verdict.get("passed") != ["verification-coverage-completion"]
        or gate_verdict.get("failed") != [] or gate_verdict.get("skipped") != []
        or not isinstance(gate_verdict.get("log_dir"), str) or not gate_verdict.get("log_dir")
    ):
        reasons.append("final profile did not emit the closed substantive passing GATE_RESULT schema")
    payload: dict[str, Any] | None = None
    try:
        parent_after = output.parent.stat(follow_symlinks=False)
        parent_identity = lambda item: (item.st_dev, item.st_ino, item.st_mode)
        if parent_identity(parent_before) != parent_identity(parent_after) or not _completion_path_is_safe(root, output):
            raise ValueError("completion output path changed during gate execution")
        payload = _stable_completion_json(output)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        reasons.append(f"completion scorecard output is invalid: {type(exc).__name__}")
    if payload is not None:
        coverage = payload.get("verification", {}).get("directory_coverage", {}) if isinstance(payload.get("verification"), dict) else {}
        critical = [
            alert.get("code") for alert in payload.get("alerts", [])
            if isinstance(alert, dict) and alert.get("severity") == "critical"
        ] if isinstance(payload.get("alerts"), list) else ["INVALID_ALERTS"]
        if payload.get("schema_version") != 1 or payload.get("completion_mode") is not True:
            reasons.append("scorecard did not attest completion mode schema v1")
        if not isinstance(coverage, dict) or coverage.get("available") is not True:
            reasons.append("verification coverage is unavailable")
        if critical:
            reasons.append("critical scorecard alerts remain: " + ", ".join(str(item) for item in critical))
        scorecard_head = payload.get("code_churn", {}).get("head") if isinstance(payload.get("code_churn"), dict) else None
        live_head = current_commit()
        if (
            not isinstance(initial_head, str) or not isinstance(scorecard_head, str)
            or not isinstance(live_head, str) or not live_head
            or initial_head != scorecard_head or scorecard_head != live_head
        ):
            reasons.append("repository HEAD changed during or was absent from completion scoring")
    if process.returncode != 0:
        reasons.append(f"completion scorecard exited {process.returncode}")
    status = "fail" if reasons else "pass"
    _persist_completion_status(state, status, reasons, output)
    return {
        "status": status, "reasons": reasons, "command": command,
        "returncode": process.returncode, "stderr_tail": (process.stderr or "")[-2000:],
        "scorecard_path": str(output), "gate_verdict": gate_verdict, "scorecard": payload,
    }


class SelfcheckError(RuntimeError):
    """Raised when a load-bearing Prime Agent runtime contract has drifted."""

    def __init__(self, report: dict[str, Any]):
        self.report = report
        failures = "; ".join(report.get("failures", [])) or "unknown compatibility failure"
        super().__init__(f"Prime Harness live selfcheck failed: {failures}")


async def selfcheck() -> dict[str, Any]:
    """Assert the non-destructive live kernel contracts the harness relies on.

    This intentionally performs host round-trips for read-only APIs. It never
    spawns/deletes a child, schedules work, changes a goal, or writes settings.
    A contract mismatch raises :class:`SelfcheckError` with the complete report.
    Session-optional controller omissions are recorded as capability warnings,
    while a provisioned controller with a changed API remains a hard failure.
    """
    import inspect

    report: dict[str, Any] = {
        "status": "pass",
        "checks": [],
        "failures": [],
        "warnings": [],
        "capabilities": {},
    }

    def check(name: str, condition: bool, observed: Any = None) -> None:
        status = "pass" if condition else "fail"
        item: dict[str, Any] = {"name": name, "status": status}
        if observed is not None:
            item["observed"] = observed
        report["checks"].append(item)
        if not condition:
            report["failures"].append(
                f"{name} (observed={observed!r})" if observed is not None else name
            )

    def warn(name: str, observed: Any = None) -> None:
        item: dict[str, Any] = {"name": name, "status": "warn"}
        if observed is not None:
            item["observed"] = observed
        report["checks"].append(item)
        report["warnings"].append(
            f"{name} (observed={observed!r})" if observed is not None else name
        )

    def record_optional_controller_absence(
        capability: str,
        request_type: str,
        exc: Exception,
        *,
        allow_not_in_kernel: bool = False,
    ) -> bool:
        message = str(exc)
        unavailable = re.fullmatch(
            rf"host request type [\"']{re.escape(request_type)}[\"'] is not available in this session",
            message,
        )
        missing_requested_controller = False
        if allow_not_in_kernel and isinstance(exc, NotInKernel):
            cause = exc.__cause__
            missing_requested_controller = (
                isinstance(cause, ModuleNotFoundError)
                and cause.name == capability
            )
        if unavailable is None and not missing_requested_controller:
            return False
        observed = f"{type(exc).__name__}: {message}"
        report["capabilities"][capability] = {
            "status": "unavailable",
            "request_type": request_type,
            "reason": observed,
        }
        warn(f"{capability} controller unavailable in this session", observed)
        return True

    # Core RLM module and read-only lifecycle/model catalog round-trips.
    try:
        rlm_mod = require_kernel_module("rlm")
        required = (
            "run",
            "find_models",
            "list_subagents",
            "delete_subagent",
            "get_harness_state",
            "harness",
        )
        missing = [name for name in required if not hasattr(rlm_mod, name)]
        check("rlm exports load-bearing APIs", not missing, missing or "all present")
        run_signature = inspect.signature(rlm_mod.run)
        check(
            "rlm.run accepts prompt plus keyword arguments",
            "prompt" in run_signature.parameters
            and any(p.kind is inspect.Parameter.VAR_KEYWORD for p in run_signature.parameters.values()),
            str(run_signature),
        )
        check("rlm.background remains absent", not hasattr(rlm_mod, "background"), hasattr(rlm_mod, "background"))

        subagents = await maybe_await(rlm_mod.list_subagents())
        check("rlm.list_subagents returns a list", isinstance(subagents, list), type(subagents).__name__)
        if isinstance(subagents, list):
            malformed = []
            for item in subagents:
                name = getattr(item, "session_name", None) or getattr(item, "name", None)
                status = getattr(item, "status", None)
                if not isinstance(name, str) or status not in {"running", "completed", "error"}:
                    malformed.append(repr(item))
            check("rlm subagent wire items match v0.7.1", not malformed, malformed or f"{len(subagents)} item(s)")

        models = await maybe_await(rlm_mod.find_models("", limit=1))
        check("rlm.find_models returns a list", isinstance(models, list), type(models).__name__)
        if isinstance(models, list) and models:
            model = models[0]
            check(
                "rlm model exposes an exact selector",
                isinstance(getattr(model, "selector", None), str) and "/" in model.selector,
                repr(model),
            )

        harness = rlm_mod.harness
        harness_methods = (
            "create_memory", "update_memory", "delete_memory",
            "create_prompt_note", "update_prompt_note", "delete_prompt_note",
            "create_skill", "update_skill", "delete_skill",
            "create_subagent", "update_subagent", "delete_subagent",
            "record_refinement", "overview",
        )
        missing_harness = [name for name in harness_methods if not callable(getattr(harness, name, None))]
        check("rlm.harness typed CRUD is available", not missing_harness, missing_harness or "all present")
    except Exception as exc:
        check("rlm live round-trips", False, f"{type(exc).__name__}: {exc}")

    # Goal is the completion and budget authority.
    try:
        goal_mod = require_kernel_module("goal")
        goal_info = await maybe_await(goal_mod.get())
        required_goal_keys = {"goal", "remaining_tokens", "completion_budget_report"}
        check(
            "goal.get wire shape",
            isinstance(goal_info, dict) and required_goal_keys <= set(goal_info),
            sorted(goal_info) if isinstance(goal_info, dict) else type(goal_info).__name__,
        )
        if isinstance(goal_info, dict) and goal_info.get("goal") is not None:
            remaining = goal_info.get("remaining_tokens")
            check(
                "goal remaining_tokens is numeric or unbounded",
                remaining is None or isinstance(remaining, (int, float)),
                type(remaining).__name__,
            )
    except Exception as exc:
        if not record_optional_controller_absence(
            "goal", "goal.get", exc, allow_not_in_kernel=True
        ):
            check("goal.get live round-trip", False, f"{type(exc).__name__}: {exc}")

    # Messaging signatures are load-bearing: v0.7.1 has no `mode` kwarg.
    try:
        agent_message_mod = require_kernel_module("agent_message")
        report["capabilities"]["agent_message"] = {
            "status": "available",
            "request_type": "agent_message.list_agents",
        }
        send_signature = inspect.signature(agent_message_mod.send)
        send_parameters = send_signature.parameters
        required_send = {"message", "broadcast_message", "receiver_role", "receiver_name"}
        check("agent_message.send required parameters", required_send <= set(send_parameters), str(send_signature))
        check("agent_message.send has no undocumented mode kwarg", "mode" not in send_parameters, str(send_signature))
        family = await maybe_await(agent_message_mod.list_agents())
        valid_family = (
            isinstance(family, dict) and isinstance(family.get("current"), dict)
            and isinstance(family.get("entries"), list)
        )
        report["capabilities"]["agent_message"]["contract_status"] = (
            "pass" if valid_family else "api_drift"
        )
        check(
            "agent_message.list_agents wire shape",
            valid_family,
            sorted(family) if isinstance(family, dict) else type(family).__name__,
        )
    except Exception as exc:
        if not record_optional_controller_absence(
            "agent_message", "agent_message.list_agents", exc
        ):
            check("agent_message live round-trips", False, f"{type(exc).__name__}: {exc}")

    # Compaction/refinement scheduling state must remain inspectable.
    for module_name, required_keys in (
        ("compact", {"tokens", "context_window", "percent", "scheduled"}),
        ("refine", {"pending", "in_flight"}),
    ):
        try:
            module = require_kernel_module(module_name)
            status = await maybe_await(module.status())
            check(
                f"{module_name}.status wire shape",
                isinstance(status, dict) and required_keys <= set(status),
                sorted(status) if isinstance(status, dict) else type(status).__name__,
            )
        except Exception as exc:
            if not record_optional_controller_absence(
                module_name,
                f"{module_name}.status",
                exc,
                allow_not_in_kernel=True,
            ):
                check(f"{module_name}.status live round-trip", False, f"{type(exc).__name__}: {exc}")

    # These read-only family/scheduler surfaces are used for recovery diagnostics.
    try:
        observe_mod = require_kernel_module("agent_observe")
        report["capabilities"]["agent_observe"] = {
            "status": "available",
            "request_type": "agent_observe.list",
        }
        observed = await maybe_await(observe_mod.list_agents())
        valid_observed = (
            isinstance(observed, dict) and isinstance(observed.get("current"), dict)
            and isinstance(observed.get("agents"), list)
        )
        report["capabilities"]["agent_observe"]["contract_status"] = (
            "pass" if valid_observed else "api_drift"
        )
        check(
            "agent_observe.list_agents wire shape",
            valid_observed,
            sorted(observed) if isinstance(observed, dict) else type(observed).__name__,
        )
    except Exception as exc:
        if not record_optional_controller_absence("agent_observe", "agent_observe.list", exc):
            check("agent_observe live round-trip", False, f"{type(exc).__name__}: {exc}")

    try:
        heartbeat_mod = require_kernel_module("rlm_heartbeat")
        report["capabilities"]["rlm_heartbeat"] = {
            "status": "available",
            "request_type": "rlm_heartbeat.list",
        }
        heartbeat_info = await maybe_await(heartbeat_mod.list(include_inactive=False))
        valid_heartbeat = (
            isinstance(heartbeat_info, dict)
            and isinstance(heartbeat_info.get("heartbeats"), list)
        )
        report["capabilities"]["rlm_heartbeat"]["contract_status"] = (
            "pass" if valid_heartbeat else "api_drift"
        )
        check(
            "rlm_heartbeat.list wire shape",
            valid_heartbeat,
            sorted(heartbeat_info) if isinstance(heartbeat_info, dict) else type(heartbeat_info).__name__,
        )
    except Exception as exc:
        if not record_optional_controller_absence("rlm_heartbeat", "rlm_heartbeat.list", exc):
            check("rlm_heartbeat live round-trip", False, f"{type(exc).__name__}: {exc}")

    # Provisioning context and governance settings.
    depth = os.environ.get("RLM_DEPTH")
    max_depth = os.environ.get("RLM_MAX_DEPTH")
    check("RLM_DEPTH is a non-negative integer", isinstance(depth, str) and depth.isdigit(), depth)
    check("RLM_MAX_DEPTH is a non-negative integer", isinstance(max_depth, str) and max_depth.isdigit(), max_depth)
    for env_name in ("RLM_SESSION_DIR", "RLM_HARNESS_STATE_DIR"):
        value = os.environ.get(env_name)
        check(f"{env_name} points to a directory", bool(value) and Path(value).is_dir(), value)

    project_settings = read_json(repo_root() / ".prime" / "agent" / "settings.json", default={})
    global_settings = read_json(Path.home() / ".prime" / "agent" / "settings.json", default={})
    auto_refine = project_settings.get("autoRefine", {}) if isinstance(project_settings, dict) else {}
    check(
        "project autoRefine is governed (disabled)",
        isinstance(auto_refine, dict) and auto_refine.get("enabled") is False,
        auto_refine,
    )

    def telemetry_explicitly_disabled(settings: Any) -> bool:
        return (
            isinstance(settings, dict)
            and isinstance(settings.get("telemetry"), dict)
            and settings["telemetry"].get("enabled") is False
        )

    disabling_env = {
        key: os.environ.get(key)
        for key in ("PRIME_AGENT_TELEMETRY", "DO_NOT_TRACK", "PI_OFFLINE")
        if str(os.environ.get(key, "")).strip().lower() in {"1", "true", "yes", "on"}
        or (key == "PRIME_AGENT_TELEMETRY" and os.environ.get(key) == "0")
    }
    check(
        "telemetry remains enabled",
        not telemetry_explicitly_disabled(global_settings)
        and not telemetry_explicitly_disabled(project_settings)
        and not disabling_env,
        disabling_env or "no disabling setting/environment override",
    )

    if report["failures"]:
        report["status"] = "fail"
        raise SelfcheckError(report)
    return report


# ---------------------------------------------------------------------------
# Module entry point
# ---------------------------------------------------------------------------


async def run() -> dict[str, Any]:
    """Status overview: task state, pending children, budget, last gate result."""
    state = load_task_state()
    gate = read_json(harness_dir() / "gate-last.json")
    return {
        "task_state": asdict(state) if state else None,
        "pending_children": pending(),
        "budget": await budget_status(),
        "last_gate": gate,
        "hint": (
            "spawn(role, task) delegates with the output contract; collect(name) reads results; "
            "sci_verify runs the verification gate; evidence_ledger records verified claims"
        ),
    }
