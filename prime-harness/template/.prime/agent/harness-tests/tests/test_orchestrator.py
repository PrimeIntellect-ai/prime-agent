from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

import harness_orchestrator as orch


@pytest.fixture(autouse=True)
def deterministic_unit_budget_authority(monkeypatch):
    async def unbounded_budget():
        return {
            "goal": {"status": "active"},
            "remaining_tokens": None,
            "budget_authority_available": True,
            "active_children": [],
        }

    monkeypatch.setattr(orch, "budget_status", unbounded_budget)


def test_task_state_roundtrip(tmp_repo):
    state = orch.new_task("t-001", "verify the integrator", working_branch="agent/t-001")
    assert state.base_commit  # pinned to HEAD
    loaded = orch.load_task_state()
    assert loaded is not None
    assert loaded.task_id == "t-001"
    loaded.unresolved_claims.append("order condition unproven")
    orch.save_task_state(loaded)
    assert orch.load_task_state().unresolved_claims == ["order condition unproven"]


def test_load_task_state_tolerates_unknown_fields(tmp_repo):
    orch.new_task("t-002", "x")
    path = orch._state_path()
    data = json.loads(path.read_text(encoding="utf-8"))
    data["future_field_from_v2"] = 42
    path.write_text(json.dumps(data), encoding="utf-8")
    assert orch.load_task_state().task_id == "t-002"


def test_admit_denies_trivial_and_unverifiable(tmp_repo, monkeypatch):
    async def unbounded_budget():
        return {"remaining_tokens": None, "min_goal_tokens_to_spawn": 20_000}

    async def no_reconcile():
        return {"marked_dead": []}

    monkeypatch.setattr(orch, "budget_status", unbounded_budget)
    monkeypatch.setattr(orch, "reconcile", no_reconcile)
    denied = asyncio.run(orch.admit("implementation-engineer", "rename a variable",
                                    independent_subproblem=False,
                                    objective_verifier_available=True))
    assert not denied
    assert any("independent" in r for r in denied.reasons)

    denied = asyncio.run(orch.admit("x", "y", independent_subproblem=True,
                                    objective_verifier_available=False))
    assert not denied

    denied = asyncio.run(orch.admit("x", "y", independent_subproblem=True,
                                    objective_verifier_available=True, expected_minutes=1))
    assert not denied


def test_admit_fails_closed_when_goal_budget_authority_is_unavailable(tmp_repo, monkeypatch):
    async def unavailable_budget():
        return {
            "goal": None,
            "remaining_tokens": None,
            "budget_authority_available": False,
            "active_children": [],
        }

    async def no_reconcile():
        return {"marked_dead": []}

    monkeypatch.setattr(orch, "budget_status", unavailable_budget)
    monkeypatch.setattr(orch, "reconcile", no_reconcile)
    admission = asyncio.run(orch.admit(
        "implementation-engineer",
        "large independent verifiable subtask",
        independent_subproblem=True,
        objective_verifier_available=True,
    ))
    assert not admission
    assert any("budget authority unavailable" in reason for reason in admission.reasons)


def test_spawn_writes_registry_and_contract(tmp_repo, fake_rlm):
    info = asyncio.run(orch.spawn("symbolic-auditor", "Check sqrt(x**2) == x for x > 0"))
    assert info["name"].startswith("symbolic-auditor-")
    assert len(fake_rlm) == 1
    prompt = fake_rlm[0]["prompt"]
    assert info["result_path"] in prompt          # contract names the exact file
    assert "Output contract (MANDATORY)" in prompt
    assert fake_rlm[0]["kwargs"] == {"name": info["name"]}

    registry = orch._load_registry()
    assert info["name"] in registry
    assert registry[info["name"]]["role"] == "symbolic-auditor"


def test_spawn_dedup_blocks_duplicate(tmp_repo, fake_rlm):
    asyncio.run(orch.spawn("symbolic-auditor", "Check claim A"))
    with pytest.raises(RuntimeError, match="duplicate"):
        asyncio.run(orch.spawn("symbolic-auditor", "check   CLAIM a"))  # normalized match
    assert len(fake_rlm) == 1


def test_spawn_respects_active_cap(tmp_repo, fake_rlm):
    for index in range(6):
        asyncio.run(orch.spawn("adversarial-reviewer", f"independent probe {index}"))
    with pytest.raises(RuntimeError, match="cap"):
        asyncio.run(orch.spawn("adversarial-reviewer", "one probe too many"))


def test_collect_validates_contract(tmp_repo, fake_rlm):
    info = asyncio.run(orch.spawn("numerical-auditor", "precision ladder on f"))
    name = info["name"]

    with pytest.raises(FileNotFoundError):
        orch.collect(name)
    assert name in orch.pending()

    result_path = Path(info["result_path"])
    result_path.write_text("not json at all", encoding="utf-8")
    with pytest.raises(ValueError, match="invalid JSON"):
        orch.collect(name)

    result_path.write_text(json.dumps({"task": "x", "status": "pass"}), encoding="utf-8")
    with pytest.raises(ValueError, match="missing required keys"):
        orch.collect(name)

    result_path.write_text(json.dumps({"task": "x", "status": "great", "summary": "s"}), encoding="utf-8")
    with pytest.raises(ValueError, match="allowed"):
        orch.collect(name)

    # fenced JSON (a model habit) is tolerated
    result_path.write_text('```json\n{"task": "x", "status": "pass", "summary": "all good"}\n```',
                           encoding="utf-8")
    result = orch.collect(name)
    assert result["status"] == "pass"
    assert name not in orch.pending()


def test_collect_unknown_child(tmp_repo):
    with pytest.raises(KeyError):
        orch.collect("nobody-001")


def test_forget_unblocks_cap_and_dedup(tmp_repo, fake_rlm):
    info = asyncio.run(orch.spawn("symbolic-auditor", "probe claim Z"))
    # duplicate blocked while pending...
    with pytest.raises(RuntimeError, match="duplicate"):
        asyncio.run(orch.spawn("symbolic-auditor", "probe claim Z"))
    # ...but a forgotten (dead) child stops blocking respawn and the cap
    orch.forget(info["name"])
    assert info["name"] not in orch.pending()
    info2 = asyncio.run(orch.spawn("symbolic-auditor", "probe claim Z"))
    assert info2["name"] != info["name"]


def test_forget_unknown_child_raises(tmp_repo):
    with pytest.raises(KeyError):
        orch.forget("ghost-001")


def test_spawn_failure_releases_reservation(tmp_repo, monkeypatch):
    import sys
    import types

    module = types.ModuleType("rlm")

    async def failing_run(prompt, **kwargs):
        raise RuntimeError("RLM recursion depth limit reached")

    module.run = failing_run
    monkeypatch.setitem(sys.modules, "rlm", module)
    with pytest.raises(RuntimeError, match="depth limit"):
        asyncio.run(orch.spawn("adversarial-reviewer", "independent probe"))
    assert orch._load_registry() == {}  # reservation rolled back → respawn possible


def test_run_overview(tmp_repo, monkeypatch):
    async def unbounded_budget():
        return {"remaining_tokens": None, "min_goal_tokens_to_spawn": 20_000}

    monkeypatch.setattr(orch, "budget_status", unbounded_budget)
    orch.new_task("t-003", "objective")
    overview = asyncio.run(orch.run())
    assert overview["task_state"]["task_id"] == "t-003"
    assert overview["pending_children"] == {}


def test_harness_snapshot_and_diff(tmp_repo, monkeypatch):
    state_dir = tmp_repo / "fake-session" / "harness"
    state_dir.mkdir(parents=True)
    state_file = state_dir / "harness_state.json"
    state_file.write_text(json.dumps({"schema": 1, "entries": {"memory": {}}}), encoding="utf-8")
    monkeypatch.setenv("RLM_HARNESS_STATE_DIR", str(state_dir))
    monkeypatch.delenv("RLM_GLOBAL_HARNESS_STATE_DIR", raising=False)

    snap = orch.harness_snapshot("before-refine")
    assert snap["copied"]["local"] == str(state_file)
    assert orch.harness_diff() == "harness state unchanged since last snapshot"

    state_file.write_text(json.dumps({"schema": 1, "entries": {"memory": {"m1": {"title": "new"}}}}),
                          encoding="utf-8")
    diff = orch.harness_diff()
    assert "m1" in diff and "+" in diff


def test_reconcile_accepts_v071_session_name(tmp_repo, monkeypatch):
    import sys
    import types

    result_path = tmp_repo / "artifacts" / "harness" / "results" / "child-live.json"
    orch._save_registry({
        "child-live": {
            "role": "adversarial-reviewer",
            "result_path": str(result_path),
            "fingerprint": "probe",
        }
    })
    module = types.ModuleType("rlm")

    async def list_subagents():
        return [types.SimpleNamespace(session_name="child-live", status="completed")]

    module.list_subagents = list_subagents
    monkeypatch.setitem(sys.modules, "rlm", module)
    result = asyncio.run(orch.reconcile())
    assert result == {"marked_dead": ["child-live"]}
    entry = orch._load_registry()["child-live"]
    assert entry["dead_reason"].startswith("session completed")


@pytest.mark.parametrize(
    "controller_mode",
    (
        "available",
        "unavailable",
        "api_drift",
        "session_optional_unavailable",
        "session_optional_not_in_kernel",
        "session_optional_broken_import",
    ),
)
def test_live_selfcheck_contract_with_kernel_stubs(tmp_repo, monkeypatch, controller_mode):
    import types

    (tmp_repo / ".prime" / "agent").mkdir(parents=True)
    (tmp_repo / ".prime" / "agent" / "settings.json").write_text(
        json.dumps({"autoRefine": {"enabled": False}}), encoding="utf-8"
    )
    harness_state_dir = tmp_repo / "fake-session" / "harness"
    harness_state_dir.mkdir(parents=True)
    monkeypatch.setenv("RLM_DEPTH", "0")
    monkeypatch.setenv("RLM_MAX_DEPTH", "1")
    monkeypatch.setenv("RLM_SESSION_DIR", str(harness_state_dir.parent))
    monkeypatch.setenv("RLM_HARNESS_STATE_DIR", str(harness_state_dir))
    monkeypatch.delenv("PRIME_AGENT_TELEMETRY", raising=False)
    monkeypatch.delenv("DO_NOT_TRACK", raising=False)
    monkeypatch.delenv("PI_OFFLINE", raising=False)

    async def rlm_run(prompt: str, **kwargs):
        return types.SimpleNamespace(name=kwargs.get("name"))

    async def find_models(query="", limit=8):
        return [types.SimpleNamespace(selector="provider/model")]

    async def list_subagents():
        return [types.SimpleNamespace(session_name="child", status="completed")]

    async def delete_subagent(target):
        return target

    harness_methods = (
        "create_memory", "update_memory", "delete_memory",
        "create_prompt_note", "update_prompt_note", "delete_prompt_note",
        "create_skill", "update_skill", "delete_skill",
        "create_subagent", "update_subagent", "delete_subagent",
        "record_refinement", "overview",
    )
    harness = types.SimpleNamespace(**{name: (lambda *args, **kwargs: None) for name in harness_methods})
    rlm_stub = types.SimpleNamespace(
        run=rlm_run,
        find_models=find_models,
        list_subagents=list_subagents,
        delete_subagent=delete_subagent,
        get_harness_state=lambda: None,
        harness=harness,
    )

    async def goal_get():
        if controller_mode == "session_optional_unavailable":
            raise RuntimeError('host request type "goal.get" is not available in this session')
        return {"goal": {"status": "active"}, "remaining_tokens": None,
                "completion_budget_report": None}

    async def send(message, broadcast_message=None, *, receiver_role=None, receiver_name=None):
        return {"deliveryStatus": "delivered"}

    async def message_list():
        if controller_mode == "unavailable":
            raise RuntimeError(
                'host request type "agent_message.list_agents" is not available in this session'
            )
        if controller_mode == "api_drift":
            return {"current": {}, "family": []}
        return {"current": {}, "entries": []}

    async def compact_status():
        if controller_mode == "session_optional_unavailable":
            raise RuntimeError('host request type "compact.status" is not available in this session')
        return {"tokens": 1, "context_window": 2, "percent": 50.0, "scheduled": False}

    async def refine_status():
        if controller_mode == "session_optional_unavailable":
            raise RuntimeError('host request type "refine.status" is not available in this session')
        return {"pending": False, "in_flight": False}

    async def observe_list():
        if controller_mode == "unavailable":
            raise RuntimeError(
                'host request type "agent_observe.list" is not available in this session'
            )
        if controller_mode == "api_drift":
            return {"current": {}, "entries": []}
        return {"current": {}, "agents": []}

    async def heartbeat_list(include_inactive=False):
        if controller_mode == "unavailable":
            raise RuntimeError(
                'host request type "rlm_heartbeat.list" is not available in this session'
            )
        if controller_mode == "api_drift":
            return {"schedules": []}
        return {"heartbeats": []}

    modules = {
        "rlm": rlm_stub,
        "goal": types.SimpleNamespace(get=goal_get),
        "agent_message": types.SimpleNamespace(send=send, list_agents=message_list),
        "compact": types.SimpleNamespace(status=compact_status),
        "refine": types.SimpleNamespace(status=refine_status),
        "agent_observe": types.SimpleNamespace(list_agents=observe_list),
        "rlm_heartbeat": types.SimpleNamespace(list=heartbeat_list),
    }
    def require_module(name):
        if controller_mode in {
            "session_optional_not_in_kernel",
            "session_optional_broken_import",
        } and name in {"goal", "compact", "refine"}:
            missing_name = (
                name if controller_mode == "session_optional_not_in_kernel"
                else "broken_controller_dependency"
            )
            cause = ModuleNotFoundError(
                f"No module named {missing_name!r}", name=missing_name
            )
            try:
                raise cause
            except ModuleNotFoundError as exc:
                raise orch.NotInKernel(
                    f"Module {name!r} is unavailable outside the kernel"
                ) from exc
        return modules[name]

    monkeypatch.setattr(orch, "require_kernel_module", require_module)
    if controller_mode in {"api_drift", "session_optional_broken_import"}:
        with pytest.raises(orch.SelfcheckError) as caught:
            asyncio.run(orch.selfcheck())
        report = caught.value.report
        assert report["status"] == "fail"
        assert len(report["failures"]) == 3
        if controller_mode == "api_drift":
            assert {
                item["contract_status"] for item in report["capabilities"].values()
            } == {"api_drift"}
        assert report["warnings"] == []
        return

    report = asyncio.run(orch.selfcheck())
    assert report["status"] == "pass"
    assert report["failures"] == []
    assert len(report["checks"]) >= 15
    capability_statuses = [item["status"] for item in report["capabilities"].values()]
    if controller_mode == "available":
        assert set(capability_statuses) == {"available"}
        assert report["warnings"] == []
    elif controller_mode == "unavailable":
        assert set(capability_statuses) == {"unavailable"}
        assert len(report["warnings"]) == 3
    else:
        assert capability_statuses.count("available") == 3
        assert capability_statuses.count("unavailable") == 3
        assert len(report["warnings"]) == 3
    assert len([item for item in report["checks"] if item["status"] == "warn"]) == len(report["warnings"])



def test_completion_check_runs_final_profile_and_persists_pass(tmp_repo):
    state = orch.new_task("completion-pass", "x", working_branch="main")
    verify = tmp_repo / "harness/verify.py"
    verify.parent.mkdir(parents=True, exist_ok=True)
    verify.write_text(
        "import json, pathlib\n"
        "out = pathlib.Path.cwd() / 'artifacts/harness/completion-scorecard.json'\n"
        "out.parent.mkdir(parents=True, exist_ok=True)\n"
        "payload = {'schema_version': 1, 'completion_mode': True, 'alerts': [], "
        "'code_churn': {'head': 'HEAD'}, 'verification': {'directory_coverage': {'available': True, 'directories': []}}}\n"
        "out.write_text(json.dumps(payload), encoding='utf-8')\n"
        "print('GATE_RESULT ' + json.dumps({'status': 'pass', 'profile': 'final', 'passed': ['verification-coverage-completion'], 'failed': [], 'skipped': [], 'log_dir': 'logs/final', 'applicable_checks': 1, 'min_applicable_checks': 1, 'vacuous': False, 'vacuous_allowed': False}))\n",
        encoding="utf-8",
    )
    original_commit = orch.current_commit
    orch.current_commit = lambda: "HEAD"
    try:
        report = orch.completion_check(timeout_seconds=30)
    finally:
        orch.current_commit = original_commit
    assert report["status"] == "pass"
    assert report["command"][-3:] == ["--profile", "final", "--json"]
    assert report["gate_verdict"]["profile"] == "final"
    assert report["scorecard"]["verification"]["directory_coverage"]["available"] is True
    assert orch.load_task_state().quality_gate_status["completion_coverage"]["status"] == "pass"


def test_completion_check_rejects_absent_git_head_even_when_scorecard_agrees(tmp_repo):
    orch.new_task("completion-no-head", "x")
    verify = tmp_repo / "harness/verify.py"
    verify.parent.mkdir(parents=True, exist_ok=True)
    verify.write_text(
        "import json, pathlib\n"
        "out = pathlib.Path.cwd() / 'artifacts/harness/completion-scorecard.json'\n"
        "out.parent.mkdir(parents=True, exist_ok=True)\n"
        "out.write_text(json.dumps({'schema_version': 1, 'completion_mode': True, 'alerts': [], 'code_churn': {'head': None}, 'verification': {'directory_coverage': {'available': True}}}), encoding='utf-8')\n"
        "print('GATE_RESULT ' + json.dumps({'status': 'pass', 'profile': 'final', 'passed': ['verification-coverage-completion'], 'failed': [], 'skipped': [], 'log_dir': 'logs/final', 'applicable_checks': 1, 'min_applicable_checks': 1, 'vacuous': False, 'vacuous_allowed': False}))\n",
        encoding="utf-8",
    )
    original_commit = orch.current_commit
    orch.current_commit = lambda: None
    try:
        report = orch.completion_check(timeout_seconds=30)
    finally:
        orch.current_commit = original_commit
    assert report["status"] == "fail"
    assert any("HEAD" in reason for reason in report["reasons"])

def test_completion_check_fails_closed_before_scorecard_with_unresolved_claims(tmp_repo):
    state = orch.new_task("completion-fail", "x")
    state.unresolved_claims = ["unproved claim"]
    orch.save_task_state(state)
    report = orch.completion_check()
    assert report["status"] == "fail"
    assert "unresolved claims" in report["reasons"][0]


def test_coverage_disposition_builder_is_task_scoped_and_path_bounded(tmp_repo):
    state = orch.new_task("coverage-disposition", "x")
    result = orch.coverage_disposition_assumptions(
        ["src", "src"], "The generated binding is verified by the signed integration oracle."
    )
    assert result == {"verification_coverage": {
        "kind": "disposition", "directories": ["src"],
        "base_commit": state.base_commit,
        "reason": "The generated binding is verified by the signed integration oracle.",
    }}
    for bad in (["../src"], ["src/subdir"], []):
        with pytest.raises(ValueError):
            orch.coverage_disposition_assumptions(
                bad, "This reason is deliberately long enough for validation."
            )



def test_completion_output_is_fixed_and_gate_verdict_schema_is_closed(tmp_repo):
    (tmp_repo / "harness/config.json").parent.mkdir(parents=True, exist_ok=True)
    (tmp_repo / "harness/config.json").write_text(
        json.dumps({"artifacts_dir": "artifacts/custom"}), encoding="utf-8"
    )
    orch.new_task("completion-fixed-output", "x")
    verify = tmp_repo / "harness/verify.py"
    verify.write_text(
        "import json, pathlib\n"
        "out = pathlib.Path.cwd() / 'artifacts/harness/completion-scorecard.json'\n"
        "out.parent.mkdir(parents=True, exist_ok=True)\n"
        "out.write_text(json.dumps({'schema_version': 1, 'completion_mode': True, 'alerts': [], 'code_churn': {'head': 'HEAD'}, 'verification': {'directory_coverage': {'available': True}}}), encoding='utf-8')\n"
        "print('GATE_RESULT ' + json.dumps({'status': 'pass', 'profile': 'final', 'passed': [], 'failed': [], 'skipped': [], 'log_dir': 'logs/final', 'applicable_checks': 1, 'min_applicable_checks': 1, 'vacuous': False, 'vacuous_allowed': False, 'unknown': True}))\n",
        encoding="utf-8",
    )
    original_commit = orch.current_commit
    orch.current_commit = lambda: "HEAD"
    try:
        report = orch.completion_check(timeout_seconds=30)
    finally:
        orch.current_commit = original_commit
    assert report["status"] == "fail"
    assert report["scorecard_path"] == str(tmp_repo / "artifacts/harness/completion-scorecard.json")
    assert any("closed substantive" in reason for reason in report["reasons"])


def test_completion_stable_reader_rejects_link_backed_output(tmp_repo):
    target = tmp_repo / "real-scorecard.json"
    target.write_text("{}", encoding="utf-8")
    link = tmp_repo / "scorecard-link.json"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlink creation unavailable")
    with pytest.raises(ValueError):
        orch._stable_completion_json(link)


def test_task_state_high_water_head_survives_repository_rewind(tmp_repo):
    state = orch.new_task("high-water", "x")
    first = orch.current_commit()
    marker = tmp_repo / "work.py"
    marker.write_text("work = True\n", encoding="utf-8")
    import subprocess
    subprocess.run(["git", "add", "work.py"], cwd=tmp_repo, check=True)
    subprocess.run(["git", "commit", "-qm", "work"], cwd=tmp_repo, check=True)
    high = orch.current_commit()
    orch.save_task_state(state)
    assert state.assumptions["highest_observed_head"] == high
    subprocess.run(["git", "reset", "--hard", first], cwd=tmp_repo, check=True, capture_output=True)
    orch.save_task_state(state)
    assert state.assumptions["highest_observed_head"] == high


def test_completion_default_timeout_leaves_margin_over_final_inner_timeout():
    import inspect
    assert inspect.signature(orch.completion_check).parameters["timeout_seconds"].default == 240
