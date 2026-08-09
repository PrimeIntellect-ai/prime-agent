from __future__ import annotations

import ast
import importlib.util
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys

import pytest
from pathlib import Path

HARNESS_ROOT = Path(__file__).resolve().parents[1]
SCORECARD = HARNESS_ROOT / "template" / "harness" / "scorecard.py"
FIXTURE = HARNESS_ROOT / "tests" / "fixtures" / "scorecard"


def load_scorecard_module():
    spec = importlib.util.spec_from_file_location("prime_harness_scorecard_tested", SCORECARD)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)
    return proc.stdout.strip()


def prepare_recorded_fixture(repo: Path) -> dict[str, Path]:
    (repo / ".gitignore").write_text("artifacts/harness/\n", encoding="utf-8")
    git(repo, "add", ".gitignore")
    git(repo, "commit", "-qm", "ignore telemetry")
    base = git(repo, "rev-parse", "HEAD")

    artifacts = repo / "artifacts" / "harness"
    telemetry = artifacts / "recorded"
    telemetry.mkdir(parents=True)
    session = telemetry / "session.jsonl"
    registry = telemetry / "rlm-subagents.jsonl"
    child = telemetry / "child-a.jsonl"
    shutil.copy2(FIXTURE / "session.jsonl", session)
    shutil.copy2(FIXTURE / "child-a.jsonl", child)
    registry_entries = [
        json.loads(line)
        for line in (FIXTURE / "rlm-subagents.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    for entry in registry_entries:
        entry["sessionFile"] = str(child) if entry["sessionFile"] == "CHILD_SESSION_A" else str(telemetry / "missing.jsonl")
        entry["parentSessionFile"] = str(session)
    registry.write_text("\n".join(json.dumps(entry) for entry in registry_entries) + "\n", encoding="utf-8")

    task = json.loads((FIXTURE / "task-state.json").read_text(encoding="utf-8"))
    task["base_commit"] = base
    task.setdefault("assumptions", {})["highest_observed_head"] = base
    task_state = artifacts / "task-state.json"
    task_state.write_text(json.dumps(task), encoding="utf-8")
    shutil.copytree(FIXTURE / "gate-logs", artifacts / "gate-logs")
    results = artifacts / "results"
    results.mkdir()
    result_a = results / "auditor-a.json"
    shutil.copy2(FIXTURE / "result-a.json", result_a)
    children_data = json.loads((FIXTURE / "children.json").read_text(encoding="utf-8"))
    children_data["auditor-a"]["result_path"] = str(result_a)
    children_data["auditor-dead"]["result_path"] = str(results / "missing-dead.json")
    children_state = artifacts / "children.json"
    children_state.write_text(json.dumps(children_data), encoding="utf-8")

    evidence = artifacts / "evidence.db"
    rows = json.loads((FIXTURE / "evidence-rows.json").read_text(encoding="utf-8"))
    connection = sqlite3.connect(evidence)
    try:
        connection.execute("CREATE TABLE evidence (id TEXT, status TEXT, verifier TEXT, created_at TEXT)")
        connection.executemany(
            "INSERT INTO evidence (id, status, verifier, created_at) VALUES (:id, :status, :verifier, :created_at)",
            rows,
        )
        connection.commit()
    finally:
        connection.close()

    source = repo / "src" / "change.py"
    source.parent.mkdir()
    source.write_text("\n".join(f"value_{index} = {index}" for index in range(120)) + "\n", encoding="utf-8")
    return {
        "artifacts": artifacts,
        "task_state": task_state,
        "session": session,
        "registry": registry,
        "children_state": children_state,
        "result_a": result_a,
        "evidence": evidence,
        "gate_logs": artifacts / "gate-logs",
    }


def run_scorecard(repo: Path, paths: dict[str, Path], *extra: str, output_name: str = "scorecard.json") -> tuple[subprocess.CompletedProcess[str], dict]:
    output = paths["artifacts"] / output_name
    markdown = paths["artifacts"] / f"{output_name}.md"
    command = [
        sys.executable,
        "-S",
        str(SCORECARD),
        "--repo",
        str(repo),
        "--task-state",
        str(paths["task_state"]),
        "--session-file",
        str(paths["session"]),
        "--registry",
        str(paths["registry"]),
        "--children-state",
        str(paths["children_state"]),
        "--evidence-db",
        str(paths["evidence"]),
        "--gate-logs",
        str(paths["gate_logs"]),
        "--now",
        "2026-01-03T00:00:00Z",
        "--output",
        str(output),
        "--markdown",
        str(markdown),
        *extra,
    ]
    proc = subprocess.run(command, cwd=repo, capture_output=True, text=True, timeout=120)
    payload = json.loads(output.read_text(encoding="utf-8")) if output.is_file() else {}
    return proc, payload


def test_recorded_fixture_metrics_and_privacy(tmp_repo: Path) -> None:
    paths = prepare_recorded_fixture(tmp_repo)
    proc, scorecard = run_scorecard(tmp_repo, paths)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout == ""
    assert scorecard["schema_version"] == 1
    assert scorecard["generated_at"] == "2026-01-03T00:00:00Z"
    assert scorecard["task"]["task_id"] == "fixture-task"
    assert scorecard["task"]["phases_passed"] == 1
    assert scorecard["task"]["phases_total"] == 3
    assert scorecard["goal"]["remaining_tokens"] == 600
    assert scorecard["usage"]["parent"]["totalTokens"] == 27
    assert scorecard["usage"]["known_task_total"]["totalTokens"] == 43
    assert scorecard["usage"]["duplicate_event_count"] == 1

    children = {child["name"]: child for child in scorecard["usage"]["children"]}
    assert children["auditor-a"]["model"] == "fixture/model-a"
    assert children["auditor-a"]["usage"]["totalTokens"] == 16
    assert children["auditor-a"]["usage"]["cost"]["total"] == 0.093
    assert children["auditor-a"]["attribution"]["target_ids"] == ["spawn-turn"]
    assert children["auditor-a"]["reported"] is True
    assert children["auditor-dead"]["usage"]["totalTokens"] == 0
    assert children["auditor-dead"]["status"] == "completed"  # exact legal daemon status
    assert children["auditor-dead"]["result_contract"] == "missing"
    assert children["auditor-dead"]["dead"] is True
    assert len(scorecard["usage"]["unattributed"]) == 1

    assert scorecard["gates"]["runs_total"] == 2
    assert scorecard["gates"]["pass_rate"] == 0.5
    assert scorecard["gates"]["substantive_pass_rate"] == 0.5
    assert scorecard["gates"]["latest"]["status"] == "pass"
    assert scorecard["gates"]["unrecovered_profiles"] == []
    assert scorecard["verification"]["records_total"] == 3
    assert scorecard["verification"]["activity_records"] == 3
    assert scorecard["verification"]["missing_task_evidence_ids"] == 1
    assert scorecard["verification"]["outside_task_records"] == 1
    assert scorecard["code_churn"]["code_lines_changed"] == 120
    assert scorecard["verification"]["records_per_100_code_lines"] == 2.5

    alert_codes = {alert["code"] for alert in scorecard["alerts"]}
    assert "GATE_HISTORY_FAILURES" in alert_codes
    assert "GATE_FAILURE" not in alert_codes
    assert {"DEAD_CHILD", "UNVERIFIED_VERIFIER_METADATA", "EVIDENCE_ID_MISSING"}.issubset(alert_codes)
    assert {"ACTIVE_CHILD_MISMATCH", "UNATTRIBUTED_CHILD_USAGE", "EVIDENCE_OUTSIDE_TASK"}.issubset(alert_codes)

    serialized = json.dumps(scorecard)
    markdown = (paths["artifacts"] / "scorecard.json.md").read_text(encoding="utf-8")
    for secret in ("PRIVATE", "spawn-child-code", "different-code", "private action"):
        assert secret not in serialized
        assert secret not in markdown


def test_same_artifacts_and_clock_produce_identical_json(tmp_repo: Path) -> None:
    paths = prepare_recorded_fixture(tmp_repo)
    first_proc, first = run_scorecard(tmp_repo, paths, output_name="first.json")
    second_proc, second = run_scorecard(tmp_repo, paths, output_name="second.json")
    assert first_proc.returncode == second_proc.returncode == 0
    assert first == second


def test_stale_child_and_heuristic_threshold_alerts(tmp_repo: Path) -> None:
    paths = prepare_recorded_fixture(tmp_repo)
    lines = [json.loads(line) for line in paths["registry"].read_text(encoding="utf-8").splitlines()]
    lines = [entry for entry in lines if not (entry["childId"] == "child-a" and entry["status"] == "completed")]
    paths["registry"].write_text("\n".join(json.dumps(entry) for entry in lines) + "\n", encoding="utf-8")
    paths["result_a"].unlink()  # running + old durable activity + no valid contract
    proc, scorecard = run_scorecard(
        tmp_repo,
        paths,
        "--stale-minutes",
        "30",
        "--min-evidence-per-100-lines",
        "3",
        output_name="stale.json",
    )
    assert proc.returncode == 0
    codes = {alert["code"] for alert in scorecard["alerts"]}
    assert "STALE_CHILD" in codes
    assert "VERIFICATION_BEHIND_CHURN" in codes


def test_ambiguous_spawn_mapping_fails_open_without_double_count(tmp_repo: Path) -> None:
    paths = prepare_recorded_fixture(tmp_repo)
    duplicate = {
        "type": "rlm_subagent",
        "childId": "child-c",
        "sessionName": "ambiguous-c",
        "sessionFile": str(paths["artifacts"] / "recorded" / "missing-c.jsonl"),
        "parentSessionFile": str(paths["session"]),
        "spawnCode": "spawn-child-code()",
        "status": "completed",
        "createdAt": "2026-01-01T01:00:31Z",
        "updatedAt": "2026-01-01T02:00:00Z",
    }
    with paths["registry"].open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(duplicate) + "\n")
    proc, scorecard = run_scorecard(tmp_repo, paths, output_name="ambiguous.json")
    assert proc.returncode == 0
    assert len(scorecard["usage"]["ambiguous"]) == 1
    assert scorecard["usage"]["totals"]["totalTokens"] == 0
    assert all(child["usage"]["totalTokens"] == 0 for child in scorecard["usage"]["children"])


def test_missing_inputs_are_best_effort_and_fail_on_is_opt_in(tmp_repo: Path) -> None:
    missing = tmp_repo / "missing"
    command = [
        sys.executable,
        "-S",
        str(SCORECARD),
        "--repo",
        str(tmp_repo),
        "--task-state",
        str(missing / "task.json"),
        "--session-file",
        str(missing / "session.jsonl"),
        "--registry",
        str(missing / "registry.jsonl"),
        "--evidence-db",
        str(missing / "evidence.db"),
        "--gate-logs",
        str(missing / "gates"),
        "--now",
        "2026-01-03T00:00:00Z",
    ]
    proc = subprocess.run(command, cwd=tmp_repo, capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    scorecard = json.loads(proc.stdout)
    codes = {alert["code"] for alert in scorecard["alerts"]}
    assert {"NO_TASK_STATE", "TELEMETRY_MISSING", "NO_GATE_RUNS", "INPUT_ANOMALY"}.issubset(codes)
    strict = subprocess.run([*command, "--fail-on", "critical"], cwd=tmp_repo, capture_output=True, text=True, timeout=120)
    assert strict.returncode == 1


def test_invalid_threshold_exits_two(tmp_repo: Path) -> None:
    proc = subprocess.run(
        [sys.executable, "-S", str(SCORECARD), "--repo", str(tmp_repo), "--stale-minutes", "-1"],
        cwd=tmp_repo,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 2
    assert "invalid" in proc.stderr


def test_scorecard_imports_only_stdlib() -> None:
    tree = ast.parse(SCORECARD.read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".", 1)[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".", 1)[0])
    assert imported <= sys.stdlib_module_names



def test_vacuous_new_profile_cannot_mask_unrecovered_default_failure(tmp_repo: Path) -> None:
    paths = prepare_recorded_fixture(tmp_repo)
    shutil.rmtree(paths["gate_logs"] / "20260102T020000Z-default")
    quick = paths["gate_logs"] / "20260102T030000Z-quick"
    quick.mkdir()
    (quick / "gate-result.json").write_text(
        json.dumps({
            "status": "pass",
            "profile": "quick",
            "passed": [],
            "failed": [],
            "skipped": ["compile"],
            "results": [{"name": "compile", "status": "skipped", "reason": "missing"}],
        }),
        encoding="utf-8",
    )
    proc, scorecard = run_scorecard(tmp_repo, paths, output_name="profiles.json")
    assert proc.returncode == 0
    assert scorecard["gates"]["pass_rate"] == 0.5
    assert scorecard["gates"]["substantive_runs"] == 1
    assert scorecard["gates"]["substantive_pass_rate"] == 0.0
    assert scorecard["gates"]["profiles"]["default"]["unrecovered_failure"] is True
    assert scorecard["gates"]["profiles"]["quick"]["vacuous_passes"] == 1
    codes = {alert["code"] for alert in scorecard["alerts"]}
    assert {"GATE_PROFILE_UNRECOVERED", "GATE_VACUOUS_PASS"}.issubset(codes)
    assert "GATE_HISTORY_FAILURES" not in codes


def test_small_live_append_clock_skew_is_included_without_future_warning(tmp_path: Path) -> None:
    scorecard = load_scorecard_module()
    end = scorecard.parse_time("2026-01-03T00:00:00Z")
    assert end is not None
    session = tmp_path / "session.jsonl"
    registry = tmp_path / "registry.jsonl"
    children = tmp_path / "children.json"
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()

    session.write_text(json.dumps({
        "type": "custom",
        "customType": "thread_goal_state",
        "timestamp": "2026-01-03T00:00:05Z",
        "data": {"goalId": "too-new"},
    }) + "\n", encoding="utf-8")
    registry.write_text(json.dumps({
        "childId": "too-new",
        "createdAt": "2026-01-03T00:00:05Z",
        "updatedAt": "2026-01-03T00:00:05Z",
    }) + "\n", encoding="utf-8")
    children.write_text(json.dumps({
        "too-new": {"spawned_at": "2026-01-03T00:00:05Z"},
    }), encoding="utf-8")
    warnings: list[str] = []
    assert scorecard.scan_session(session, None, end, warnings)["goal"]["goalId"] == "too-new"
    assert [
        child["child_id"]
        for child in scorecard.scan_registry(registry, None, end, 30, warnings)["children"]
    ] == ["too-new"]
    assert "too-new" in scorecard.scan_children_state(
        children, artifacts, None, end, warnings
    )["records"]
    assert not any("future_entry" in warning for warning in warnings)

    session.write_text(session.read_text(encoding="utf-8").replace("00:00:05Z", "00:00:11Z"), encoding="utf-8")
    registry.write_text(registry.read_text(encoding="utf-8").replace("00:00:05Z", "00:00:11Z"), encoding="utf-8")
    children.write_text(children.read_text(encoding="utf-8").replace("00:00:05Z", "00:00:11Z"), encoding="utf-8")
    warnings = []
    scorecard.scan_session(session, None, end, warnings)
    scorecard.scan_registry(registry, None, end, 30, warnings)
    scorecard.scan_children_state(children, artifacts, None, end, warnings)
    assert {"session:future_entry", "registry:future_entry", "children_state:future_entry"} <= set(warnings)


def test_explicit_historical_now_has_no_live_clock_skew(tmp_repo: Path) -> None:
    paths = prepare_recorded_fixture(tmp_repo)
    with paths["session"].open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({
            "type": "custom",
            "customType": "thread_goal_state",
            "timestamp": "2026-01-03T00:00:05Z",
            "data": {"goalId": "after-explicit-cutoff"},
        }) + "\n")
    proc, scorecard = run_scorecard(tmp_repo, paths, output_name="strict-now.json")
    assert proc.returncode == 0
    assert scorecard["goal"]["goal_id"] == "goal-fixture"
    assert "FUTURE_EVENT" in {alert["code"] for alert in scorecard["alerts"]}


def test_discover_session_file_honors_override_and_relocated_layout(tmp_path: Path, monkeypatch) -> None:
    scorecard = load_scorecard_module()
    session_id = "session-123"
    relocated_session_dir = tmp_path / "relocated-agent/session-artifacts" / session_id
    relocated_session_dir.mkdir(parents=True)
    sibling_sessions = relocated_session_dir.parent.parent / "sessions"
    sibling_sessions.mkdir()
    sibling_file = sibling_sessions / f"{session_id}.jsonl"
    sibling_file.write_text("{}\n", encoding="utf-8")
    monkeypatch.delenv("PRIME_AGENT_SESSION_DIR", raising=False)
    monkeypatch.delenv("PRIME_AGENT_CODING_AGENT_SESSION_DIR", raising=False)
    assert scorecard.discover_session_file(relocated_session_dir, None) == sibling_file

    override_sessions = tmp_path / "explicit-sessions"
    override_sessions.mkdir()
    override_file = override_sessions / f"{session_id}.jsonl"
    override_file.write_text("{}\n", encoding="utf-8")
    monkeypatch.setenv("PRIME_AGENT_SESSION_DIR", str(override_sessions))
    assert scorecard.discover_session_file(relocated_session_dir, None) == override_file
    override_file.unlink()
    assert scorecard.discover_session_file(relocated_session_dir, None) is None


def test_now_is_inclusive_upper_bound_for_every_durable_stream(tmp_repo: Path) -> None:
    paths = prepare_recorded_fixture(tmp_repo)
    future_session = [
        {
            "type": "message",
            "id": "future-message",
            "timestamp": "2030-01-01T00:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "toolCall", "arguments": {"code": "future-code()"}}],
                "usage": {
                    "input": 1000,
                    "output": 1000,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 2000,
                    "cost": {"input": 10, "output": 10, "cacheRead": 0, "cacheWrite": 0, "total": 20},
                },
            },
        },
        {
            "type": "custom",
            "customType": "thread_goal_state",
            "id": "future-goal",
            "timestamp": "2030-01-01T00:00:01Z",
            "data": {"active": True, "status": "active", "goalId": "future", "tokenBudget": 1000, "tokensUsed": 999},
        },
    ]
    with paths["session"].open("a", encoding="utf-8") as handle:
        for entry in future_session:
            handle.write(json.dumps(entry) + "\n")
    future_registry = {
        "type": "rlm_subagent",
        "childId": "child-a",
        "sessionName": "auditor-a",
        "sessionFile": str(paths["artifacts"] / "recorded" / "child-a.jsonl"),
        "parentSessionFile": str(paths["session"]),
        "spawnCode": "future-code()",
        "status": "deleted",
        "createdAt": 1767229230000,
        "updatedAt": "2030-01-01T00:00:00Z",
    }
    with paths["registry"].open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(future_registry) + "\n")
    future_gate = paths["gate_logs"] / "20300101T000000Z-default"
    future_gate.mkdir()
    (future_gate / "gate-result.json").write_text(
        json.dumps({"status": "fail", "profile": "default", "results": [{"name": "future", "status": "fail"}]}),
        encoding="utf-8",
    )
    connection = sqlite3.connect(paths["evidence"])
    try:
        connection.execute(
            "INSERT INTO evidence (id, status, verifier, created_at) VALUES (?, ?, ?, ?)",
            ("future-evidence", "verified", "future", "2030-01-01T00:00:00Z"),
        )
        connection.commit()
    finally:
        connection.close()
    task = json.loads(paths["task_state"].read_text(encoding="utf-8"))
    task["evidence_ids"].append("future-evidence")
    paths["task_state"].write_text(json.dumps(task), encoding="utf-8")

    proc, scorecard = run_scorecard(tmp_repo, paths, output_name="bounded.json")
    assert proc.returncode == 0
    assert scorecard["usage"]["parent"]["totalTokens"] == 27
    assert scorecard["goal"]["goal_id"] == "goal-fixture"
    assert scorecard["gates"]["runs_total"] == 2
    assert scorecard["children"]["records"][0]["status"] == "completed"
    assert scorecard["verification"]["records_total"] == 3
    assert scorecard["verification"]["missing_task_evidence_ids"] == 2
    assert "FUTURE_EVENT" in {alert["code"] for alert in scorecard["alerts"]}


def test_child_result_path_is_confined_to_artifact_root(tmp_repo: Path) -> None:
    paths = prepare_recorded_fixture(tmp_repo)
    outside = tmp_repo / "outside-result.json"
    outside.write_text(json.dumps({"status": "pass", "summary": "PRIVATE OUTSIDE RESULT"}), encoding="utf-8")
    children = json.loads(paths["children_state"].read_text(encoding="utf-8"))
    children["auditor-dead"]["result_path"] = str(outside)
    paths["children_state"].write_text(json.dumps(children), encoding="utf-8")
    proc, scorecard = run_scorecard(tmp_repo, paths, output_name="confined.json")
    assert proc.returncode == 0
    dead = next(child for child in scorecard["children"]["records"] if child["name"] == "auditor-dead")
    assert dead["result_contract"] == "outside_artifact_root"
    assert dead["dead"] is True
    assert "children_state:result_path_rejected" in scorecard["warnings"]
    assert "PRIVATE OUTSIDE RESULT" not in json.dumps(scorecard)


def test_markdown_escapes_untrusted_child_names(tmp_repo: Path) -> None:
    paths = prepare_recorded_fixture(tmp_repo)
    malicious = "<script>alert(1)</script>|`child`"
    registry = [json.loads(line) for line in paths["registry"].read_text(encoding="utf-8").splitlines()]
    for entry in registry:
        if entry["childId"] == "child-a":
            entry["sessionName"] = malicious
    paths["registry"].write_text("\n".join(json.dumps(entry) for entry in registry) + "\n", encoding="utf-8")
    children = json.loads(paths["children_state"].read_text(encoding="utf-8"))
    children[malicious] = children.pop("auditor-a")
    paths["children_state"].write_text(json.dumps(children), encoding="utf-8")
    proc, _scorecard = run_scorecard(tmp_repo, paths, output_name="escaped.json")
    assert proc.returncode == 0
    markdown = (paths["artifacts"] / "escaped.json.md").read_text(encoding="utf-8")
    assert "<script>" not in markdown
    assert "&lt;script&gt;" in markdown
    assert "&#96;child&#96;" in markdown
    assert "\\|" in markdown
    assert "â€”" not in markdown
    assert "** -- " in markdown


def test_incomplete_gate_archive_is_reported_not_counted_as_a_run(tmp_repo: Path) -> None:
    paths = prepare_recorded_fixture(tmp_repo)
    (paths["gate_logs"] / "20260102T040000Z-default").mkdir()
    proc, scorecard = run_scorecard(tmp_repo, paths, output_name="incomplete-gate.json")
    assert proc.returncode == 0
    assert scorecard["gates"]["runs_total"] == 2
    assert scorecard["gates"]["incomplete_archives"] == 1
    assert "GATE_INCOMPLETE" in {alert["code"] for alert in scorecard["alerts"]}

def test_readme_documents_every_emitted_alert_code() -> None:
    source = SCORECARD.read_text(encoding="utf-8")
    codes = set(re.findall(r'add_alert\(alerts, "([A-Z_]+)"', source))
    contract_doc = (HARNESS_ROOT / "docs/alert-codes.md").read_text(encoding="utf-8")
    assert codes
    assert all(f"`{code}`" in contract_doc for code in codes)



def _prepare_completion_coverage_fixture(repo: Path) -> tuple[dict[str, Path], str, str]:
    (repo / ".gitignore").write_text("artifacts/harness/\n", encoding="utf-8")
    git(repo, "add", ".gitignore")
    git(repo, "commit", "-qm", "coverage base")
    base = git(repo, "rev-parse", "HEAD")
    for relative in ("src/model.py", "lib/solver.py", "docs/generated.py"):
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(f"value_{index} = {index}" for index in range(200)) + "\n", encoding="utf-8")
    git(repo, "add", "src/model.py", "lib/solver.py", "docs/generated.py")
    git(repo, "commit", "-qm", "code churn")
    change = git(repo, "rev-parse", "HEAD")

    artifacts = repo / "artifacts/harness"
    artifacts.mkdir(parents=True)
    task_state = artifacts / "task-state.json"
    task_state.write_text(json.dumps({
        "task_id": "coverage-task", "objective": "coverage", "base_commit": base,
        "working_branch": git(repo, "branch", "--show-current"),
        "assumptions": {"highest_observed_head": change},
        "unresolved_claims": [], "active_child_names": [],
        "quality_gate_status": {}, "created_at": "2026-01-01T00:00:00Z",
        "evidence_ids": ["ev-commit", "ev-src"],
    }), encoding="utf-8")
    children = artifacts / "children.json"
    children.write_text("{}\n", encoding="utf-8")
    session = artifacts / "session.jsonl"
    session.write_text(
        json.dumps({"type": "session", "id": "coverage-session", "timestamp": "2026-01-01T00:00:00Z"}) + "\n" +
        json.dumps({"type": "custom", "customType": "thread_goal_state", "id": "goal", "timestamp": "2026-01-02T00:00:00Z", "data": {"active": True, "status": "active", "goalId": "coverage-goal", "tokenBudget": 1000, "tokensUsed": 100, "updatedAt": 1767312000000}}) + "\n",
        encoding="utf-8",
    )
    registry = artifacts / "registry.jsonl"
    registry.write_text("", encoding="utf-8")
    gate_logs = artifacts / "gate-logs"
    gate_logs.mkdir()
    evidence = artifacts / "evidence.db"
    connection = sqlite3.connect(evidence)
    try:
        connection.execute("""CREATE TABLE evidence (
            id TEXT, status TEXT, verifier TEXT, created_at TEXT, claim_type TEXT,
            assumptions TEXT, commit_sha TEXT, invalidated_at TEXT
        )""")
        common = ("verified", "pytest", "2026-01-02T00:00:00Z", "test", None)
        connection.execute(
            "INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("ev-commit", *common[:4], "{}", change, common[4]),
        )
        connection.execute(
            "INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("ev-src", *common[:4], json.dumps({"verification_coverage": {
                "kind": "verification", "directories": ["src"], "base_commit": base,
            }}), change, common[4]),
        )
        connection.commit()
    finally:
        connection.close()
    config = repo / "harness/config.json"
    config.parent.mkdir()
    config.write_text(json.dumps({"verification_coverage": {
        "min_evidence_per_100_lines": 1.0,
        "churn_alert_min_lines": 100,
        "exempt_globs": ["docs/**"],
    }}), encoding="utf-8")
    return {
        "artifacts": artifacts, "task_state": task_state,
        "session": session,
        "registry": registry,
        "children_state": children, "evidence": evidence, "gate_logs": gate_logs,
    }, base, change


def test_completion_coverage_is_per_directory_configurable_and_requires_signed_disposition(tmp_repo: Path) -> None:
    paths, base, change = _prepare_completion_coverage_fixture(tmp_repo)
    failed, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert failed.returncode == 1
    coverage = payload["verification"]["directory_coverage"]
    assert coverage["policy"]["exempt_globs"] == ["docs/**"]
    rows = {row["directory"]: row for row in coverage["directories"]}
    assert rows["src"]["status"] == "pass"
    assert rows["src"]["records_per_100_lines"] == 1.0
    assert rows["lib"]["status"] == "behind"
    assert "docs" not in rows
    alert = next(item for item in payload["alerts"] if item["code"] == "VERIFICATION_BEHIND_CHURN")
    assert alert["severity"] == "critical"
    assert alert["metrics"]["directories"] == ["lib"]

    disposition = {
        "verification_coverage": {
            "kind": "disposition", "directories": ["lib"], "base_commit": base,
            "reason": "Generated adapter churn is covered by the signed integration oracle.",
        }
    }
    connection = sqlite3.connect(paths["evidence"])
    try:
        connection.execute(
            "INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("ev-lib-disposition", "verified", "independent coverage auditor",
             "2026-01-02T01:00:00Z", "verification-coverage-disposition",
             json.dumps(disposition), change, None),
        )
        connection.commit()
    finally:
        connection.close()
    task = json.loads(paths["task_state"].read_text(encoding="utf-8"))
    task["evidence_ids"].append("ev-lib-disposition")
    paths["task_state"].write_text(json.dumps(task), encoding="utf-8")
    passed, payload = run_scorecard(
        tmp_repo, paths, "--completion", "--fail-on", "critical", output_name="covered.json"
    )
    assert passed.returncode == 0, passed.stdout + passed.stderr
    rows = {row["directory"]: row for row in payload["verification"]["directory_coverage"]["directories"]}
    assert rows["lib"]["status"] == "disposition"
    assert rows["lib"]["disposition_evidence_ids"] == ["ev-lib-disposition"]
    assert not any(item["code"] == "VERIFICATION_BEHIND_CHURN" for item in payload["alerts"])


def test_completion_rejects_malformed_or_unsigned_coverage_dispositions(tmp_repo: Path) -> None:
    paths, base, change = _prepare_completion_coverage_fixture(tmp_repo)
    connection = sqlite3.connect(paths["evidence"])
    try:
        connection.execute(
            "INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("ev-bad", "verified", "", "2026-01-02T01:00:00Z",
             "verification-coverage-disposition", json.dumps({"verification_coverage": {
                 "kind": "disposition", "directories": ["../lib"], "base_commit": base,
                 "reason": "This text is long enough but the path and signer are invalid.",
             }}), change, None),
        )
        connection.commit()
    finally:
        connection.close()
    task = json.loads(paths["task_state"].read_text(encoding="utf-8"))
    task["evidence_ids"].append("ev-bad")
    paths["task_state"].write_text(json.dumps(task), encoding="utf-8")
    proc, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert proc.returncode == 1
    assert any(item["code"] == "VERIFICATION_BEHIND_CHURN" for item in payload["alerts"])
    assert "evidence:invalid_coverage_metadata:ev-bad" in payload["warnings"]



@pytest.mark.parametrize("policy", [
    {"unknown": 1},
    {"min_evidence_per_100_lines": True},
    {"min_evidence_per_100_lines": 0},
    {"min_evidence_per_100_lines": float("inf")},
    {"churn_alert_min_lines": -1},
    {"churn_alert_min_lines": 101},
    {"exempt_globs": "docs/**"},
    {"exempt_globs": ["../generated/**"]},
    {"exempt_globs": ["**"]},
    {"exempt_globs": ["src/**"]},
    {"exempt_globs": ["C:\\outside\\**"]},
])
def test_coverage_policy_rejects_ambiguous_or_unsafe_config(tmp_repo: Path, policy: dict) -> None:
    paths, _base, _change = _prepare_completion_coverage_fixture(tmp_repo)
    (tmp_repo / "harness/config.json").write_text(
        json.dumps({"verification_coverage": policy}), encoding="utf-8"
    )
    proc, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert proc.returncode == 2
    assert payload == {}
    assert "scorecard:" in proc.stderr


def test_completion_fails_closed_when_evidence_schema_cannot_prove_coverage(tmp_repo: Path) -> None:
    paths = prepare_recorded_fixture(tmp_repo)
    proc, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert proc.returncode == 1
    alert = next(item for item in payload["alerts"] if item["code"] == "VERIFICATION_COVERAGE_UNAVAILABLE")
    assert alert["severity"] == "critical"



def test_completion_fails_closed_for_missing_unresolvable_or_empty_churn_base(tmp_repo: Path) -> None:
    paths, _base, change = _prepare_completion_coverage_fixture(tmp_repo)
    task = json.loads(paths["task_state"].read_text(encoding="utf-8"))
    for index, bad_base in enumerate((None, "0" * 40, change)):
        if bad_base is None:
            task.pop("base_commit", None)
        else:
            task["base_commit"] = bad_base
        paths["task_state"].write_text(json.dumps(task), encoding="utf-8")
        proc, payload = run_scorecard(
            tmp_repo, paths, "--completion", "--fail-on", "critical",
            output_name=f"bad-base-{index}.json",
        )
        assert proc.returncode == 1
        codes = {item["code"] for item in payload["alerts"] if item["severity"] == "critical"}
        assert codes.intersection({"VERIFICATION_CHURN_BASE_UNAVAILABLE", "VERIFICATION_CHURN_INTERVAL_EMPTY"})


def test_dispositions_require_live_task_range_commit_and_malformed_rows_never_get_automatic_credit(tmp_repo: Path) -> None:
    paths, base, change = _prepare_completion_coverage_fixture(tmp_repo)
    connection = sqlite3.connect(paths["evidence"])
    try:
        for evidence_id, assumptions, commit_sha in (
            ("ev-forged", {"verification_coverage": {
                "kind": "disposition", "directories": ["lib"], "base_commit": base,
                "reason": "This purported disposition has no live repository commit.",
            }}, "0" * 40),
            ("ev-malformed-signed", {"verification_coverage": {
                "kind": "disposition", "directories": ["../lib"], "base_commit": base,
                "reason": "This malformed disposition must never earn ordinary verification credit.",
            }}, change),
        ):
            connection.execute(
                "INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (evidence_id, "verified", "named but unauthenticated text",
                 "2026-01-02T01:00:00Z", "verification-coverage-disposition",
                 json.dumps(assumptions), commit_sha, None),
            )
        connection.commit()
    finally:
        connection.close()
    task = json.loads(paths["task_state"].read_text(encoding="utf-8"))
    task["evidence_ids"].extend(["ev-forged", "ev-malformed-signed"])
    paths["task_state"].write_text(json.dumps(task), encoding="utf-8")
    proc, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert proc.returncode == 1
    lib = next(row for row in payload["verification"]["directory_coverage"]["directories"] if row["directory"] == "lib")
    assert lib["status"] == "behind"
    assert "ev-forged" not in lib["disposition_evidence_ids"]
    assert "ev-malformed-signed" not in lib["verification_evidence_ids"]


def test_refuted_and_inconclusive_rows_do_not_satisfy_completion_coverage(tmp_repo: Path) -> None:
    paths, _base, _change = _prepare_completion_coverage_fixture(tmp_repo)
    connection = sqlite3.connect(paths["evidence"])
    try:
        connection.execute("UPDATE evidence SET status='refuted' WHERE id='ev-commit'")
        connection.execute("UPDATE evidence SET status='inconclusive' WHERE id='ev-src'")
        connection.commit()
    finally:
        connection.close()
    proc, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert proc.returncode == 1
    rows = payload["verification"]["directory_coverage"]["directories"]
    assert all(row["verification_records"] == 0 for row in rows)
    assert any(row["status"] == "behind" for row in rows)


def test_binary_code_churn_cannot_evade_completion_coverage(tmp_repo: Path) -> None:
    paths, _base, _change = _prepare_completion_coverage_fixture(tmp_repo)
    binary = tmp_repo / "binary/payload.py"
    binary.parent.mkdir()
    binary.write_bytes(b"\x00\x01compiled payload")
    git(tmp_repo, "add", "binary/payload.py")
    git(tmp_repo, "commit", "-qm", "binary code")
    proc, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert proc.returncode == 1
    row = next(item for item in payload["verification"]["directory_coverage"]["directories"] if item["directory"] == "binary")
    assert row["unmeasured_binary_files"] == 1
    assert row["status"] == "behind"



def test_coverage_policy_config_read_is_bounded(tmp_repo: Path) -> None:
    paths, _base, _change = _prepare_completion_coverage_fixture(tmp_repo)
    (tmp_repo / "harness/config.json").write_bytes(b" " * (1024 * 1024 + 1))
    proc, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert proc.returncode == 2
    assert payload == {}
    assert "stable bounded regular file" in proc.stderr



def test_completion_rejects_divergent_task_base_and_regressed_high_water_head(tmp_repo: Path) -> None:
    paths, base, change = _prepare_completion_coverage_fixture(tmp_repo)
    git(tmp_repo, "checkout", "-q", "--detach", base)
    alternate = tmp_repo / "alternate.py"
    alternate.write_text("alternate = True\n", encoding="utf-8")
    git(tmp_repo, "add", "alternate.py")
    git(tmp_repo, "commit", "-qm", "divergent completion head")
    task = json.loads(paths["task_state"].read_text(encoding="utf-8"))
    task["base_commit"] = change
    task["assumptions"]["highest_observed_head"] = change
    paths["task_state"].write_text(json.dumps(task), encoding="utf-8")
    proc, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert proc.returncode == 1
    codes = {item["code"] for item in payload["alerts"]}
    assert "VERIFICATION_CHURN_RANGE_INVALID" in codes
    assert "VERIFICATION_HEAD_REGRESSION" in codes


def test_completion_detects_hard_reset_before_highest_observed_work(tmp_repo: Path) -> None:
    paths, _base, change = _prepare_completion_coverage_fixture(tmp_repo)
    marker = tmp_repo / "src/verified_work.py"
    marker.write_text("verified = True\n", encoding="utf-8")
    git(tmp_repo, "add", "src/verified_work.py")
    git(tmp_repo, "commit", "-qm", "verified high water")
    high_water = git(tmp_repo, "rev-parse", "HEAD")
    task = json.loads(paths["task_state"].read_text(encoding="utf-8"))
    task["assumptions"]["highest_observed_head"] = high_water
    paths["task_state"].write_text(json.dumps(task), encoding="utf-8")
    git(tmp_repo, "reset", "--hard", change)
    proc, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert proc.returncode == 1
    assert "VERIFICATION_HEAD_REGRESSION" in {item["code"] for item in payload["alerts"]}


def test_verification_metadata_cannot_credit_directory_untouched_by_evidence_commit(tmp_repo: Path) -> None:
    paths, base, _change = _prepare_completion_coverage_fixture(tmp_repo)
    source = tmp_repo / "src/only.py"
    source.write_text("only_src = True\n", encoding="utf-8")
    git(tmp_repo, "add", "src/only.py")
    git(tmp_repo, "commit", "-qm", "src-only evidence commit")
    src_only_commit = git(tmp_repo, "rev-parse", "HEAD")
    connection = sqlite3.connect(paths["evidence"])
    try:
        connection.execute("UPDATE evidence SET status='refuted' WHERE id='ev-commit'")
        connection.execute(
            "UPDATE evidence SET assumptions=?, commit_sha=? WHERE id='ev-src'",
            (json.dumps({"verification_coverage": {
                "kind": "verification", "directories": ["lib"], "base_commit": base,
            }}), src_only_commit),
        )
        connection.commit()
    finally:
        connection.close()
    task = json.loads(paths["task_state"].read_text(encoding="utf-8"))
    task["assumptions"]["highest_observed_head"] = src_only_commit
    paths["task_state"].write_text(json.dumps(task), encoding="utf-8")
    proc, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert proc.returncode == 1
    row = next(item for item in payload["verification"]["directory_coverage"]["directories"] if item["directory"] == "lib")
    assert row["verification_records"] == 0
    assert row["status"] == "behind"


def test_each_binary_code_file_receives_full_conservative_churn_charge(tmp_repo: Path) -> None:
    paths, _base, _change = _prepare_completion_coverage_fixture(tmp_repo)
    for index in range(3):
        path = tmp_repo / f"binary/payload_{index}.py"
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b"\x00compiled")
    git(tmp_repo, "add", "binary")
    git(tmp_repo, "commit", "-qm", "three binary code files")
    proc, payload = run_scorecard(tmp_repo, paths, "--completion", "--fail-on", "critical")
    assert proc.returncode == 1
    row = next(item for item in payload["verification"]["directory_coverage"]["directories"] if item["directory"] == "binary")
    assert row["unmeasured_binary_files"] == 3
    assert row["code_lines_changed"] == 300
    assert row["records_per_100_lines"] == 0.0
    assert row["status"] == "behind"


def test_policy_and_artifact_paths_derive_from_one_stable_config_snapshot(tmp_repo: Path, monkeypatch) -> None:
    module = load_scorecard_module()
    config = tmp_repo / "harness/config.json"
    config.parent.mkdir()
    config.write_text(json.dumps({
        "artifacts_dir": "artifacts/custom",
        "verification_coverage": {"min_evidence_per_100_lines": 2.0},
    }), encoding="utf-8")
    calls = {"count": 0}
    original = module._stable_bounded_config
    def counted(path):
        calls["count"] += 1
        return original(path)
    monkeypatch.setattr(module, "_stable_bounded_config", counted)
    document = module.load_harness_config(tmp_repo)
    policy = module.load_coverage_policy(tmp_repo, document)
    artifacts = module.load_artifacts_dir(tmp_repo, document)
    assert calls["count"] == 1
    assert policy["min_evidence_per_100_lines"] == 2.0
    assert artifacts == tmp_repo / "artifacts/custom"
