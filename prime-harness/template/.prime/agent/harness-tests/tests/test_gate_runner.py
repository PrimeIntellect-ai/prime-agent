from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

HARNESS_ROOT = Path(__file__).resolve().parents[1]
VERIFY = HARNESS_ROOT / "template" / "harness" / "verify.py"


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
    proc = run_gate(tmp_repo)
    assert proc.returncode == 0
    assert gate_result(proc.stdout)["skipped"] == ["lean"]


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
    payload = json.dumps({"profiles": {"default": {"required": []}}})
    (tmp_repo / "harness" / "manifest.json").write_bytes(b"\xef\xbb\xbf" + payload.encode("utf-8"))
    proc = run_gate(tmp_repo)
    assert proc.returncode == 0, proc.stdout + proc.stderr


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
