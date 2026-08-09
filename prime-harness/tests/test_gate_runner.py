from __future__ import annotations

import json
import os
import shutil
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
