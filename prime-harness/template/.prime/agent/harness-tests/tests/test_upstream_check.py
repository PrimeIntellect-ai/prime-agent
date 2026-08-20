from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
UPSTREAM_CHECK = ROOT / "template/harness/upstream_check.py"
SPEC = importlib.util.spec_from_file_location("prime_harness_upstream_check", UPSTREAM_CHECK)
assert SPEC and SPEC.loader
watch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watch)


def make_source(root: Path) -> Path:
    kernel = root / "packages/coding-agent/src/core/kernel"
    kernel.mkdir(parents=True)
    (kernel / "bootstrap.ts").write_text(
        "function venvPythonPath(venv: string) {\n"
        "  return process.platform === 'win32'\n"
        "    ? path.join(venv, 'Scripts', 'python.exe')\n"
        "    : path.join(venv, 'bin', 'python');\n"
        "}\n"
        "const one = venvPythonPath(venv);\n"
        "const two = venvPythonPath(venv);\n"
        "spawn(command, args, { windowsHide: true });\n",
        encoding="utf-8",
    )
    (kernel / "fork-server.ts").write_text(
        "spawn(python, args, { windowsHide: true });\n", encoding="utf-8"
    )
    (kernel / "index.ts").write_text(
        "spawn(python, args, { windowsHide: true }); // #660/#825\n",
        encoding="utf-8",
    )
    return root


def test_snapshot_detects_binary_source_and_patch_drift(tmp_path):
    binary = tmp_path / "prime-agent"
    binary.write_bytes(b"launcher-v1")
    source = make_source(tmp_path / "source-tree")
    snapshot = watch.capture_current(
        ROOT / "template",
        prime_binary=binary,
        source_root=source,
        version_override="0.7.1",
    )
    assert snapshot["prime_agent"]["version"] == "0.7.1"
    assert snapshot["patch_state"] == {
        "venv_python_path": True,
        "windows_hide": True,
    }
    stable = watch.compare_snapshots(snapshot, snapshot, pr_825_merged=False)
    assert stable["status"] == "stable" and stable["reasons"] == []

    changed_binary = copy.deepcopy(snapshot)
    changed_binary["prime_agent"]["binary_sha256"] = "0" * 64
    drift = watch.compare_snapshots(snapshot, changed_binary, pr_825_merged=False)
    assert drift["status"] == "drift"
    assert any("binary hash" in reason for reason in drift["reasons"])

    missing_patch = copy.deepcopy(snapshot)
    missing_patch["patch_state"]["windows_hide"] = False
    drift = watch.compare_snapshots(snapshot, missing_patch, pr_825_merged=False)
    assert any("windowsHide" in reason for reason in drift["reasons"])

    retirement = watch.compare_snapshots(snapshot, snapshot, pr_825_merged=True)
    assert retirement["status"] == "retirement_required"
    assert any("#825" in reason for reason in retirement["reasons"])





def test_incomplete_identity_baseline_is_deferred_and_legacy_copy_self_heals(tmp_path):
    path = tmp_path / "baseline.json"
    unavailable = {
        "schema_version": watch.SCHEMA_VERSION,
        "prime_agent": {"version": None, "binary_sha256": None, "source_root": None},
        "patch_state": {}, "source_file_sha256": {}, "archived_patch_sha256": {},
    }
    assert watch.record_baseline(path, unavailable, force=False) == "deferred-unavailable"
    assert not path.exists()

    # Simulate a baseline created by the pre-fix installer before Prime Agent existed.
    watch.atomic_write_json(path, unavailable)
    available = copy.deepcopy(unavailable)
    available["prime_agent"].update({"version": "0.7.1", "binary_sha256": "a" * 64})
    assert watch.record_baseline(path, available, force=False) == "replaced-incomplete"
    assert json.loads(path.read_text(encoding="utf-8"))["prime_agent"]["version"] == "0.7.1"
    assert watch.record_baseline(path, {**available, "captured_at": "later"}, force=False) == "unchanged"


def test_baseline_is_create_once_unless_force_is_explicit(tmp_path):
    baseline = tmp_path / "baseline.json"
    first = {"schema_version": 1, "prime_agent": {"version": "0.7.1", "binary_sha256": "a" * 64}}
    second = {"schema_version": 1, "prime_agent": {"version": "0.8.0", "binary_sha256": "b" * 64}}
    assert watch.record_baseline(baseline, first, force=False) == "created"
    assert watch.record_baseline(baseline, second, force=False) == "unchanged"
    assert json.loads(baseline.read_text(encoding="utf-8")) == first
    assert watch.record_baseline(baseline, second, force=True) == "replaced"
    assert json.loads(baseline.read_text(encoding="utf-8")) == second


def test_pr_825_payload_is_bounded_and_fail_closed():
    assert watch.parse_pr_825_payload(b'{"state":"open","merged_at":null}') is False
    assert watch.parse_pr_825_payload(
        b'{"state":"closed","merged_at":"2026-08-09T00:00:00Z"}'
    ) is True
    for invalid in (b'[]', b'{"merged_at": 1}', b'{' + b' ' * 70_000 + b'}'):
        try:
            watch.parse_pr_825_payload(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("invalid PR payload was accepted")


def test_archived_local_patches_apply_to_pristine_upstream_and_reproduce_postpatch_hashes(tmp_path):
    patch_dir = ROOT / "template/harness/patches/prime-agent"
    fixture = ROOT / "tests/fixtures/prime-agent-prepatch"
    worktree = tmp_path / "pristine"
    shutil.copytree(fixture, worktree)
    subprocess.run(["git", "init", "-q"], cwd=worktree, check=True)
    subprocess.run(["git", "config", "core.autocrlf", "false"], cwd=worktree, check=True)
    for patch in (
        patch_dir / "windows-kernel-venv-python.patch",
        patch_dir / "windows-kernel-windows-hide.patch",
    ):
        applied = subprocess.run(
            ["git", "apply", str(patch)], cwd=worktree,
            capture_output=True, text=True, timeout=30,
        )
        assert applied.returncode == 0, applied.stderr
    expected = {
        "packages/coding-agent/src/core/kernel/bootstrap.ts": "fd6e5b4c250c82c1ec6a94a89fa401f27ff722360fb8f4dca9aab3badd2eae72",
        "packages/coding-agent/src/core/kernel/fork-server.ts": "7a6545774cb92906895152f6ab94e9989a6b0b6106cb5576a94dea82621653f9",
        "packages/coding-agent/src/core/kernel/index.ts": "48f5748cb307e944b6104cff16d8dc8b4fcab9fee3b80d9d9bf9812c7e474c66"
}
    for relative, digest in expected.items():
        patched = (worktree / relative).read_bytes().replace(b"\r\n", b"\n")
        assert hashlib.sha256(patched).hexdigest() == digest


def test_scheduled_pr_watch_is_read_only_pinned_and_calls_bounded_probe():
    import re
    import yaml

    path = ROOT / "template/.github/workflows/upstream-watch.yml"
    text = path.read_text(encoding="utf-8")
    document = yaml.safe_load(text)
    assert document["permissions"] == {"contents": "read"}
    assert document[True]["schedule"]
    steps = document["jobs"]["pr-825"]["steps"]
    uses = [step["uses"] for step in steps if "uses" in step]
    assert all(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[0-9a-f]{40}", value) for value in uses)
    probe_step = next(step for step in steps if "upstream_check.py --check-pr-only" in str(step.get("run", "")))
    assert probe_step["env"] == {"GITHUB_TOKEN": "${{ secrets.GITHUB_TOKEN }}"}



def test_query_pr_825_uses_optional_github_token(monkeypatch):
    captured = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit):
            return b'{"state":"open","merged_at":null}'

    def opener(request, timeout):
        captured.append((request, timeout))
        return Response()

    monkeypatch.setenv("GITHUB_TOKEN", "bounded-test-token")
    assert watch.query_pr_825(opener) is False
    assert captured[-1][0].get_header("Authorization") == "Bearer bounded-test-token"
    monkeypatch.delenv("GITHUB_TOKEN")
    assert watch.query_pr_825(opener) is False
    assert captured[-1][0].get_header("Authorization") is None


def test_patch_signature_drift_is_baseline_relative_and_source_aware(tmp_path):
    binary = tmp_path / "prime-agent"
    binary.write_bytes(b"launcher-v1")
    source = make_source(tmp_path / "source-tree")
    patched = watch.capture_current(
        ROOT / "template", prime_binary=binary, source_root=source, version_override="0.7.1",
    )
    never_patched = copy.deepcopy(patched)
    never_patched["patch_state"] = {"venv_python_path": False, "windows_hide": False}
    assert watch.compare_snapshots(never_patched, never_patched, pr_825_merged=False) == {
        "status": "stable", "reasons": [],
    }

    regressed = watch.compare_snapshots(patched, never_patched, pr_825_merged=False)
    assert regressed["status"] == "drift"
    assert any("venvPythonPath" in reason for reason in regressed["reasons"])
    assert any("windowsHide" in reason for reason in regressed["reasons"])

    distribution = copy.deepcopy(never_patched)
    distribution["prime_agent"]["source_root"] = None
    distribution["source_file_sha256"] = {}
    assert watch.compare_snapshots(distribution, distribution, pr_825_merged=False) == {
        "status": "stable", "reasons": [],
    }



def test_check_pr_failure_is_explicitly_degraded_and_reduces_ledger_confidence(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(watch, "probe", lambda _root, check_pr: {
        "comparison": {"status": "stable", "reasons": []},
        "pr_query_requested": check_pr,
        "pr_query_ok": False,
        "warnings": ["network unavailable"],
    })
    monkeypatch.setattr(watch, "_run_doctor", lambda _root: {"status": "pass"})
    monkeypatch.setattr(watch, "kernel_critical_probe", lambda: {"status": "pass"})
    monkeypatch.setattr(watch, "_artifact_path", lambda _root: tmp_path / "check.json")
    recorded = {}

    def record(_root, _artifact, passed, *, degraded):
        recorded.update(passed=passed, degraded=degraded)
        return {"status": "pass", "evidence_id": "ev-degraded"}

    monkeypatch.setattr(watch, "_record_evidence", record)
    assert watch.main(["--repo", str(tmp_path), "--check-pr", "--json"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["status"] == "pass-degraded"
    assert recorded == {"passed": True, "degraded": True}


def test_local_pr_scan_is_full_history_and_retirement_marker_is_one_way(tmp_path, monkeypatch):
    source = tmp_path / "source"
    (source / ".git").mkdir(parents=True)
    calls = []

    class GitResult:
        returncode = 0
        stdout = "Merge pull request #825 from upstream\n"

    def fake_run(command, **kwargs):
        calls.append(command)
        return GitResult()

    monkeypatch.setattr(watch.subprocess, "run", fake_run)
    assert watch._local_pr_825_merge(source) is True
    assert calls == [["git", "log", "--format=%s"]]

    root = tmp_path / "repo"
    snapshot = {
        "schema_version": watch.SCHEMA_VERSION,
        "prime_agent": {"version": "0.7.1", "binary_sha256": "a", "source_root": str(source)},
        "patch_state": {"venv_python_path": False, "windows_hide": False},
        "source_file_sha256": {}, "archived_patch_sha256": {},
    }
    watch.atomic_write_json(watch.baseline_path(root), snapshot)
    monkeypatch.setattr(watch, "capture_current", lambda _root: copy.deepcopy(snapshot))
    merge_values = iter((True, False))
    monkeypatch.setattr(watch, "_local_pr_825_merge", lambda _source: next(merge_values))
    first = watch.probe(root)
    assert first["pr_825_merged"] is True
    assert watch.retirement_marker_path(root).is_file()
    second = watch.probe(root)
    assert second["pr_825_merged"] is True
    assert second["comparison"]["status"] == "retirement_required"
