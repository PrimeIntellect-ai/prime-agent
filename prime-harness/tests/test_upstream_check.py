from __future__ import annotations

import copy
import importlib.util
import json
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


def test_baseline_is_create_once_unless_force_is_explicit(tmp_path):
    baseline = tmp_path / "baseline.json"
    first = {"schema_version": 1, "prime_agent": {"version": "0.7.1"}}
    second = {"schema_version": 1, "prime_agent": {"version": "0.8.0"}}
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


def test_archived_local_patches_are_parseable_and_cover_both_fixes():
    patch_dir = ROOT / "template/harness/patches/prime-agent"
    venv_patch = patch_dir / "windows-kernel-venv-python.patch"
    hide_patch = patch_dir / "windows-kernel-windows-hide.patch"
    assert "venvPythonPath" in venv_patch.read_text(encoding="utf-8")
    hide_text = hide_patch.read_text(encoding="utf-8")
    assert hide_text.count("windowsHide: true") == 3
    for patch in (venv_patch, hide_patch):
        parsed = subprocess.run(
            ["git", "apply", "--numstat", str(patch)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert parsed.returncode == 0, parsed.stderr


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
