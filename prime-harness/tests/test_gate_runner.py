from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sqlite3
import time
import subprocess
import sys
from pathlib import Path

import pytest

HARNESS_ROOT = Path(__file__).resolve().parents[1]
GATE_TEMPLATE = HARNESS_ROOT / "template" / "harness"
VERIFY = GATE_TEMPLATE / "verify.py"
MANIFEST_POLICY = GATE_TEMPLATE / "manifest_policy.py"
BURST_SH = GATE_TEMPLATE / "burst.sh"
BURST_PS1 = GATE_TEMPLATE / "burst.ps1"


def write_manifest(repo: Path, profiles: dict) -> None:
    (repo / "harness").mkdir(exist_ok=True)
    (repo / "harness" / "manifest.json").write_text(json.dumps({"profiles": profiles}), encoding="utf-8")


def run_gate(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(VERIFY), *args], cwd=str(repo),
                          capture_output=True, text=True, timeout=300)


def gate_result(stdout: str) -> dict:
    for line in reversed(stdout.strip().splitlines()):
        if line.startswith("GATE_RESULT "):
            return json.loads(line[len("GATE_RESULT "):])
    raise AssertionError(f"no GATE_RESULT line in:\n{stdout}")


def test_passing_profile_exits_zero(tmp_repo):
    write_manifest(tmp_repo, {"default": {"required": [
        {"name": "ok", "command": f'"{sys.executable}" -c "print(42)"'},
    ], "conditional": []}})
    proc = run_gate(tmp_repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    verdict = gate_result(proc.stdout)
    assert verdict["status"] == "pass"
    assert verdict["passed"] == ["ok"]
    assert (tmp_repo / "artifacts" / "harness" / "gate-last.json").is_file()


def test_failing_check_exits_one_with_excerpt(tmp_repo):
    write_manifest(tmp_repo, {"default": {"required": [
        {"name": "boom", "command": f'"{sys.executable}" -c "print(\'diagnostic detail\'); raise SystemExit(3)"'},
    ]}})
    proc = run_gate(tmp_repo)
    assert proc.returncode == 1
    assert gate_result(proc.stdout)["failed"] == ["boom"]
    assert "diagnostic detail" in proc.stdout  # excerpt surfaces the cause


def test_skip_if_missing(tmp_repo):
    write_manifest(tmp_repo, {"default": {"required": [
        {"name": "lean", "command": "definitely-not-a-command", "skip_if_missing": "checks/lean"},
    ]}})
    proc = run_gate(tmp_repo, "--allow-vacuous")
    assert proc.returncode == 0
    verdict = gate_result(proc.stdout)
    assert verdict["skipped"] == ["lean"]
    assert verdict["vacuous_allowed"] is True


def test_all_skipped_profile_fails_vacuous_by_default(tmp_repo):
    write_manifest(tmp_repo, {"default": {"required": [
        {"name": "missing", "command": "never-runs", "skip_if_missing": "absent"},
    ], "conditional": []}})
    proc = run_gate(tmp_repo)
    assert proc.returncode != 0
    verdict = gate_result(proc.stdout)
    assert verdict["status"] == "vacuous"
    assert verdict["applicable_checks"] == 0
    assert verdict["min_applicable_checks"] == 1


def test_profile_minimum_can_require_multiple_applicable_checks(tmp_repo):
    write_manifest(tmp_repo, {"default": {"min_applicable_checks": 2, "required": [
        {"name": "only", "command": f'"{sys.executable}" -c "print(1)"'},
        {"name": "missing", "command": "never-runs", "skip_if_missing": "absent"},
    ], "conditional": []}})
    proc = run_gate(tmp_repo)
    assert proc.returncode != 0
    verdict = gate_result(proc.stdout)
    assert verdict["status"] == "vacuous"
    assert verdict["passed"] == ["only"]
    assert verdict["applicable_checks"] == 1
    assert verdict["min_applicable_checks"] == 2


def test_invalid_minimum_fails_closed(tmp_repo):
    write_manifest(tmp_repo, {"default": {"min_applicable_checks": -1, "required": [], "conditional": []}})
    proc = run_gate(tmp_repo)
    assert proc.returncode != 0
    verdict = gate_result(proc.stdout)
    assert verdict["status"] == "error"
    assert "min_applicable_checks" in verdict["reason"]


def test_conditional_when_changed(tmp_repo):
    write_manifest(tmp_repo, {"default": {
        "required": [],
        "conditional": [
            {"name": "symbolic", "command": f'"{sys.executable}" -c "print(\'sym\')"',
             "when_changed": ["src/symbolic/**"]},
            {"name": "sim", "command": "should-not-run",
             "when_changed": ["src/simulation/**"]},
        ]}})
    target = tmp_repo / "src" / "symbolic"
    target.mkdir(parents=True)
    (target / "algebra.py").write_text("x = 1\n", encoding="utf-8")  # untracked change

    proc = run_gate(tmp_repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    verdict = gate_result(proc.stdout)
    assert verdict["passed"] == ["symbolic"]
    assert verdict["skipped"] == ["sim"]





def _changed_files_from_git_output(monkeypatch, *, status_output: str, diff_output: str):
    monkeypatch.syspath_prepend(str(GATE_TEMPLATE))
    spec = importlib.util.spec_from_file_location("gate_verify_nul_test", VERIFY)
    assert spec and spec.loader
    verify = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verify)
    calls = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        if "status" in command:
            return subprocess.CompletedProcess(command, 0, status_output, "")
        if "rev-parse" in command:
            return subprocess.CompletedProcess(command, 0, "resolved\n", "")
        if "diff" in command:
            return subprocess.CompletedProcess(command, 0, diff_output, "")
        raise AssertionError(f"unexpected git command: {command}")

    monkeypatch.setattr(verify.subprocess, "run", fake_run)
    files, resolved = verify.changed_files(Path.cwd(), "HEAD")
    return verify, files, resolved, calls


def test_changed_files_preserves_literal_arrow_path_with_nul_porcelain(monkeypatch):
    literal = "checks/properties/a -> b.py"
    verify, files, resolved, calls = _changed_files_from_git_output(
        monkeypatch, status_output=f"?? {literal}\0", diff_output=f"{literal}\0",
    )
    assert resolved == "HEAD"
    assert files == [literal]
    assert verify.matches_any(files, ["checks/properties/**"])
    assert ["git", "-c", "core.quotePath=false", "status", "--porcelain", "-z", "-uall"] in calls
    assert ["git", "-c", "core.quotePath=false", "diff", "--name-only", "-z", "HEAD...HEAD"] in calls


def test_changed_files_consumes_genuine_nul_rename_record(monkeypatch):
    destination = "docs/new.py"
    source = "checks/properties/old.py"
    _verify, files, _resolved, _calls = _changed_files_from_git_output(
        monkeypatch, status_output=f"R  {destination}\0{source}\0", diff_output="",
    )
    assert files == sorted([destination, source])
    assert all("\0" not in path for path in files)


def test_nul_paths_and_rename_sources_drive_when_changed_globs(monkeypatch):
    literal = "checks/properties/a -> b.py"
    renamed_destination = "docs/moved.py"
    renamed_source = "src/symbolic/original.py"
    verify, files, _resolved, _calls = _changed_files_from_git_output(
        monkeypatch,
        status_output=f"?? {literal}\0R  {renamed_destination}\0{renamed_source}\0",
        diff_output="",
    )
    assert verify.matches_any(files, ["checks/properties/**"])
    assert verify.matches_any(files, ["src/symbolic/**"])
    assert not verify.matches_any(files, ["src/simulation/**"])





def test_genuine_rename_source_triggers_when_changed_glob(tmp_repo):
    source = tmp_repo / "checks/properties/original.py"
    source.parent.mkdir(parents=True)
    source.write_text("VALUE = 1\n", encoding="utf-8")
    subprocess.run(["git", "add", source.relative_to(tmp_repo).as_posix()], cwd=tmp_repo, check=True)
    subprocess.run(["git", "commit", "-qm", "add property source"], cwd=tmp_repo, check=True)
    destination = tmp_repo / "docs/moved.py"
    destination.parent.mkdir()
    subprocess.run(
        ["git", "mv", source.relative_to(tmp_repo).as_posix(), destination.relative_to(tmp_repo).as_posix()],
        cwd=tmp_repo, check=True,
    )
    write_manifest(tmp_repo, {"default": {
        "required": [{"name": "always", "command": f'"{sys.executable}" -c "print(1)"'}],
        "conditional": [{
            "name": "property-on-rename",
            "command": f'"{sys.executable}" -c "print(2)"',
            "when_changed": ["checks/properties/**"],
        }],
    }})
    proc = run_gate(tmp_repo, "--base", "HEAD")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    verdict = gate_result(proc.stdout)
    assert verdict["passed"] == ["always", "property-on-rename"]
    assert verdict["skipped"] == []


def test_timeout_kills_and_fails(tmp_repo):
    write_manifest(tmp_repo, {"default": {"required": [
        {"name": "sleepy", "command": f'"{sys.executable}" -c "import time; time.sleep(60)"',
         "timeout_seconds": 2},
    ]}})
    proc = run_gate(tmp_repo)
    assert proc.returncode == 1
    assert "sleepy" in gate_result(proc.stdout)["failed"]


def test_output_stays_under_gate_cap(tmp_repo):
    checks = [{"name": f"chatty-{i}",
               "command": f'"{sys.executable}" -c "print(\'x\' * 5000); raise SystemExit(1)"'}
              for i in range(8)]
    write_manifest(tmp_repo, {"default": {"required": checks}})
    proc = run_gate(tmp_repo)
    assert proc.returncode == 1
    assert len(proc.stdout) < 6000  # Prime Agent truncates gate streams at 6000 chars


def test_unknown_profile_errors(tmp_repo):
    write_manifest(tmp_repo, {"default": {"required": []}})
    proc = run_gate(tmp_repo, "--profile", "nope")
    assert proc.returncode == 1
    assert gate_result(proc.stdout)["status"] == "error"


def test_missing_manifest_emits_gate_result_on_stdout(tmp_repo):
    proc = run_gate(tmp_repo)  # no harness/manifest.json written
    assert proc.returncode == 1
    verdict = gate_result(proc.stdout)  # STDOUT is the documented contract
    assert verdict["status"] == "error"
    assert "manifest not found" in verdict["reason"]


def test_explicit_bad_base_fails_closed(tmp_repo):
    write_manifest(tmp_repo, {"default": {"required": [], "conditional": [
        {"name": "sym", "command": "x", "when_changed": ["src/**"]},
    ]}})
    proc = run_gate(tmp_repo, "--base", "no-such-ref")
    assert proc.returncode == 1
    verdict = gate_result(proc.stdout)
    assert verdict["status"] == "error"
    assert "did not resolve" in verdict["reason"]


def test_bare_python_command_rewritten_to_interpreter(tmp_repo):
    # `python -c ...` must run with the gate's interpreter even where PATH has
    # no `python` (python3-only systems, WindowsApps stubs).
    write_manifest(tmp_repo, {"default": {"required": [
        {"name": "interp", "command": "python -c \"import sys; print(sys.executable)\""},
    ]}})
    proc = run_gate(tmp_repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert gate_result(proc.stdout)["passed"] == ["interp"]


def test_manifest_with_bom_is_tolerated(tmp_repo):
    (tmp_repo / "harness").mkdir(exist_ok=True)
    payload = json.dumps({"profiles": {"default": {"required": [
        {"name": "ok", "command": f'"{sys.executable}" -c "print(1)"'},
    ]}}})
    (tmp_repo / "harness" / "manifest.json").write_bytes(b"\xef\xbb\xbf" + payload.encode("utf-8"))
    proc = run_gate(tmp_repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert gate_result(proc.stdout)["status"] == "pass"


def test_custom_artifacts_dir_honored(tmp_repo):
    write_manifest(tmp_repo, {"default": {"required": [
        {"name": "ok", "command": f'"{sys.executable}" -c "print(1)"'},
    ]}})
    (tmp_repo / "harness" / "config.json").write_text(
        json.dumps({"artifacts_dir": "out/state"}), encoding="utf-8")
    proc = run_gate(tmp_repo)
    assert proc.returncode == 0
    assert (tmp_repo / "out" / "state" / "gate-last.json").is_file()
    assert not (tmp_repo / "artifacts").exists()


def test_json_mode_suppresses_detail(tmp_repo):
    write_manifest(tmp_repo, {"default": {"required": [
        {"name": "ok", "command": f'"{sys.executable}" -c "print(1)"'},
    ]}})
    proc = run_gate(tmp_repo, "--json")
    lines = [l for l in proc.stdout.strip().splitlines() if l]
    assert len(lines) == 1 and lines[0].startswith("GATE_RESULT ")


def test_list_mode(tmp_repo):
    write_manifest(tmp_repo, {"default": {"required": [{"name": "a", "command": "x"}]}})
    proc = run_gate(tmp_repo, "--list")
    assert proc.returncode == 0
    assert "profile default" in proc.stdout


def test_burst_launchers_freeze_complete_gate_dependency_set():
    shell = BURST_SH.read_text(encoding="utf-8")
    powershell = BURST_PS1.read_text(encoding="utf-8")
    assert "cp harness/verify.py harness/manifest.json harness/manifest_policy.py" in shell
    assert r'Copy-Item "harness\manifest_policy.py" -Destination $GateDir' in powershell


def test_frozen_burst_gate_dir_emits_gate_result(tmp_repo, tmp_path):
    frozen = tmp_path / "gate-definition"
    frozen.mkdir()
    shutil.copy2(VERIFY, frozen / "verify.py")
    shutil.copy2(MANIFEST_POLICY, frozen / "manifest_policy.py")
    manifest = frozen / "manifest.json"
    manifest.write_text(json.dumps({"profiles": {"quick": {"required": [
        {"name": "ok", "command": f'"{sys.executable}" -c "print(1)"'},
    ]}}}), encoding="utf-8")
    assert sorted(path.name for path in frozen.iterdir()) == [
        "manifest.json", "manifest_policy.py", "verify.py",
    ]
    proc = subprocess.run(
        [sys.executable, str(frozen / "verify.py"), "--manifest", str(manifest), "--profile", "quick"],
        cwd=tmp_repo, capture_output=True, text=True, timeout=300,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert gate_result(proc.stdout)["status"] == "pass"


def test_posix_burst_invocation_uses_frozen_dependency_set(tmp_repo, tmp_path):
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash is unavailable")
    harness = tmp_repo / "harness"
    harness.mkdir(exist_ok=True)
    for source in (BURST_SH, VERIFY, MANIFEST_POLICY):
        shutil.copy2(source, harness / source.name)
    (harness / "manifest.json").write_text(json.dumps({"profiles": {"quick": {"required": [
        {"name": "ok", "command": f'"{sys.executable}" -c "print(1)"'},
    ]}}}), encoding="utf-8")

    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    stub_python = stub_dir / "prime_stub.py"
    stub_python.write_text(
        "import json, pathlib, subprocess, sys\n"
        "args = sys.argv[1:]\n"
        "gate = args[args.index('--autonomous-gate') + 1]\n"
        "verify = gate.split('\"', 2)[1]\n"
        "frozen = pathlib.Path(verify).parent\n"
        "print('FROZEN_FILES ' + json.dumps(sorted(p.name for p in frozen.iterdir())))\n"
        "proc = subprocess.run(gate, shell=True, text=True, capture_output=True)\n"
        "sys.stdout.write(proc.stdout); sys.stderr.write(proc.stderr)\n"
        "raise SystemExit(proc.returncode)\n",
        encoding="utf-8",
    )
    stub = stub_dir / "prime-agent"
    python_executable = str(Path(sys.executable).resolve()).replace("\\", "/")
    stub_python_path = str(stub_python.resolve()).replace("\\", "/")
    stub.write_text(
        f'#!/usr/bin/env bash\nexec "{python_executable}" "{stub_python_path}" "$@"\n',
        encoding="utf-8",
    )
    stub.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = str(stub_dir) + os.pathsep + env.get("PATH", "")
    proc = subprocess.run(
        [bash, str(harness / "burst.sh"), "repair", "frozen gate smoke"],
        cwd=tmp_repo, env=env, capture_output=True, text=True, timeout=300,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert 'FROZEN_FILES ["manifest.json", "manifest_policy.py", "verify.py"]' in proc.stdout
    assert gate_result(proc.stdout)["status"] == "pass"



def test_final_profile_is_nonvacuous_fails_behind_churn_then_passes_with_coverage(tmp_repo, monkeypatch):
    harness = tmp_repo / "harness"
    harness.mkdir(exist_ok=True)
    shutil.copy2(GATE_TEMPLATE / "scorecard.py", harness / "scorecard.py")
    (harness / "config.json").write_text(json.dumps({
        "verification_coverage": {
            "min_evidence_per_100_lines": 1.0,
            "churn_alert_min_lines": 100,
            "exempt_globs": ["docs/**", "generated/**"],
        }
    }), encoding="utf-8")
    write_manifest(tmp_repo, {"final": {
        "conditional": [],
        "min_applicable_checks": 1,
        "required": [{
            "command": "python -S harness/scorecard.py --completion --fail-on critical --output artifacts/harness/completion-scorecard.json",
            "name": "verification-coverage-completion",
            "skip_if_missing": "harness/scorecard.py",
            "timeout_seconds": 180,
        }],
    }})
    (tmp_repo / ".gitignore").write_text("artifacts/harness/\n", encoding="utf-8")
    subprocess.run(["git", "add", ".gitignore", "harness"], cwd=tmp_repo, check=True)
    subprocess.run(["git", "commit", "-qm", "coverage base"], cwd=tmp_repo, check=True)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=tmp_repo, check=True,
        capture_output=True, text=True,
    ).stdout.strip()
    source = tmp_repo / "src/model.py"
    source.parent.mkdir()
    source.write_text("\n".join(f"value_{index} = {index}" for index in range(200)) + "\n", encoding="utf-8")
    subprocess.run(["git", "add", "src/model.py"], cwd=tmp_repo, check=True)
    subprocess.run(["git", "commit", "-qm", "code churn"], cwd=tmp_repo, check=True)
    change = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=tmp_repo, check=True,
        capture_output=True, text=True,
    ).stdout.strip()

    artifacts = tmp_repo / "artifacts/harness"
    artifacts.mkdir(parents=True)
    session_dir = artifacts / "rlm/task-session"
    session_dir.mkdir(parents=True)
    (session_dir / "rlm-subagents.jsonl").write_text("", encoding="utf-8")
    sessions = artifacts / "sessions"
    sessions.mkdir()
    now_ms = int(time.time() * 1000)
    (sessions / "task-session.jsonl").write_text(
        json.dumps({"type": "session", "id": "final-gate", "timestamp": "2026-01-01T00:00:00Z"}) + "\n" +
        json.dumps({"type": "custom", "customType": "thread_goal_state", "id": "goal", "timestamp": "2026-01-01T00:00:01Z", "data": {"active": True, "status": "active", "goalId": "final-gate", "tokenBudget": 1000, "tokensUsed": 1, "updatedAt": now_ms}}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("RLM_SESSION_DIR", str(session_dir))
    (artifacts / "children.json").write_text("{}\n", encoding="utf-8")
    evidence = artifacts / "evidence.db"
    connection = sqlite3.connect(evidence)
    try:
        connection.execute("""CREATE TABLE evidence (
            id TEXT, status TEXT, verifier TEXT, created_at TEXT, claim_type TEXT,
            assumptions TEXT, commit_sha TEXT, invalidated_at TEXT
        )""")
        for evidence_id in ("ev-one", "ev-two"):
            assumptions = json.dumps({"verification_coverage": {
                "kind": "verification", "directories": ["src"], "base_commit": base,
            }})
            connection.execute(
                "INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (evidence_id, "verified", "independent property suite",
                 "2026-01-01T00:01:00Z", "test", assumptions, change, None),
            )
        connection.commit()
    finally:
        connection.close()

    task = {
        "task_id": "final-gate", "objective": "prove red and green", "base_commit": base,
        "working_branch": "main", "assumptions": {"highest_observed_head": change},
        "unresolved_claims": [], "active_child_names": [],
        "quality_gate_status": {}, "created_at": "2026-01-01T00:00:00Z",
        "evidence_ids": ["ev-one"],
    }
    task_path = artifacts / "task-state.json"
    task_path.write_text(json.dumps(task), encoding="utf-8")

    red = run_gate(tmp_repo, "--profile", "final", "--json")
    red_verdict = gate_result(red.stdout)
    assert red.returncode == 1
    assert red_verdict["status"] == "fail"
    assert red_verdict["applicable_checks"] == 1
    assert red_verdict["vacuous"] is False
    red_scorecard = json.loads((artifacts / "completion-scorecard.json").read_text(encoding="utf-8"))
    red_alert = next(item for item in red_scorecard["alerts"] if item["code"] == "VERIFICATION_BEHIND_CHURN")
    assert red_alert["severity"] == "critical"
    assert red_alert["metrics"]["directories"] == ["src"]

    shutil.rmtree(artifacts / "gate-logs")
    (artifacts / "gate-last.json").unlink()
    task["evidence_ids"].append("ev-two")
    task_path.write_text(json.dumps(task), encoding="utf-8")
    green = run_gate(tmp_repo, "--profile", "final", "--json")
    green_verdict = gate_result(green.stdout)
    assert green.returncode == 0, green.stdout + green.stderr
    assert green_verdict["status"] == "pass"
    assert green_verdict["passed"] == ["verification-coverage-completion"]
    assert green_verdict["applicable_checks"] == 1
    assert green_verdict["vacuous"] is False
