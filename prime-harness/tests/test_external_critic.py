from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

import external_critic as critic


def test_extract_plain_array():
    findings = critic._extract_json_array('[{"severity": "major", "file": "a.py"}]')
    assert findings == [{"severity": "major", "file": "a.py"}]


def test_extract_from_fenced_block():
    text = 'Here is my review:\n```json\n[{"severity": "minor", "claim": "x"}]\n```\nDone.'
    assert critic._extract_json_array(text)[0]["severity"] == "minor"


def test_extract_from_claude_json_wrapper():
    wrapped = json.dumps({"type": "result", "result": '[{"severity": "critical", "claim": "bad"}]'})
    assert critic._extract_json_array(wrapped)[0]["severity"] == "critical"


def test_extract_empty_array_from_noise():
    assert critic._extract_json_array("No issues found.\n\n[]") == []


def test_extract_garbage_returns_none():
    assert critic._extract_json_array("I could not complete the review, sorry.") is None
    assert critic._extract_json_array("") is None
    assert critic._extract_json_array('["not-a-finding"]') is None


def test_extract_rejects_ambiguous_distinct_findings_arrays():
    real = [{"severity": "major", "file": "module.py", "claim": "real finding"}]
    noisy = f"Repository text quoted this array:\n```json\n[]\n```\nActual review:\n{json.dumps(real)}"
    assert critic._extract_json_array(noisy) is None


def test_extract_deduplicates_identical_findings_arrays():
    findings = [{"severity": "major", "file": "module.py", "claim": "same finding"}]
    encoded = json.dumps(findings)
    assert critic._extract_json_array(f"```json\n{encoded}\n```\nRepeated: {encoded}") == findings


def test_extract_ignores_unpaired_quote_in_prose_before_array():
    findings = [{"severity": "major", "file": "a.py", "claim": "x"}]
    text = f'The 5" display path is affected\n{json.dumps(findings)}'
    assert critic._extract_json_array(text) == findings


def test_extract_ignores_bracket_arrays_inside_finding_strings():
    findings = [{
        "severity": "major",
        "file": "module.py",
        "claim": "quoted [{}] syntax must remain inert",
        "evidence": "input [{}] and [] crash the parser",
        "proposed_falsification_test": "parse the output",
    }]
    assert critic._extract_json_array(f"Review notes\n{json.dumps(findings)}") == findings


def test_finding_linkage_uses_exact_identifier_boundaries():
    assert critic._references_exact_id("verified: finding-1.", "finding-1")
    assert not critic._references_exact_id("verified: finding-10.", "finding-1")
    assert not critic._references_exact_id("verified: prefix-finding-1-suffix", "finding-1")


def test_severity_counts():
    counts = critic._severity_counts([{"severity": "Major"}, {"severity": "major"}, {}])
    assert counts == {"major": 2, "info": 1}


def test_review_empty_diff_short_circuits(tmp_repo):
    # base resolves to local 'main', head == main → empty diff, no critic launched
    result = critic.review(tool="claude")
    assert result["status"] == "done"
    assert result["findings"] == []
    assert "empty diff" in result.get("note", "")
    # contract consistency: every "done" result carries findings_path + counts
    assert result["counts"] == {}
    assert json.loads(Path(result["findings_path"]).read_text(encoding="utf-8"))["findings"] == []


def test_review_bad_head_errors(tmp_repo):
    result = critic.review(head="no-such-ref")
    assert result["status"] == "error"
    assert "cannot resolve head" in result["reason"]


def test_available_critics_is_ordered_subset():
    assert set(critic.available_critics()) <= {"claude", "codex"}



def _commit_change(repo: Path) -> None:
    (repo / "module.py").write_text("def verify(value):\n    return value\n", encoding="utf-8")
    subprocess.run(["git", "add", "module.py"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-qm", "change"], cwd=repo, check=True, capture_output=True)


def _python_adapter(findings, *, delay=0.0, valid=True):
    payload = json.dumps(findings)
    code = (
        "import json,time; from pathlib import Path; "
        "assert Path('REVIEW_DIFF.patch').is_file(); assert not Path('.git').exists(); "
        f"time.sleep({delay!r}); "
        + (f"print({payload!r})" if valid else "print('not-json')")
    )
    return lambda prompt: [sys.executable, "-c", code, prompt]


def test_panel_runs_independent_tools_in_parallel_and_surfaces_disagreements(tmp_repo, monkeypatch):
    _commit_change(tmp_repo)
    claude_findings = [{
        "severity": "major", "file": "module.py", "line": 2,
        "claim": "Digest mismatch is swallowed and incorrectly returns pass",
        "evidence": "failure path returns success",
        "proposed_falsification_test": "supply a mismatching digest",
    }]
    codex_findings = [{
        "severity": "critical", "file": "./module.py", "line": 2,
        "claim": "Digest mismatch is swallowed and incorrectly returns pass",
        "evidence": "integrity failure is accepted",
        "proposed_falsification_test": "assert mismatch returns failure",
    }, {
        "severity": "minor", "file": "other.py", "line": 8,
        "claim": "An unrelated documentation issue exists",
        "evidence": "stale text",
        "proposed_falsification_test": "compare docs",
    }]
    monkeypatch.setitem(critic._ADAPTERS, "claude", _python_adapter(claude_findings, delay=1.0))
    monkeypatch.setitem(critic._ADAPTERS, "codex", _python_adapter(codex_findings, delay=1.0))
    started = time.monotonic()
    result = critic.review_panel("audit", base="HEAD^", timeout_seconds=10)
    elapsed = time.monotonic() - started
    assert result["status"] == "done"
    assert result["verdict"] == "action_required"
    assert elapsed < 1.8, f"workstreams appear sequential: {elapsed:.3f}s"
    assert set(result["workstreams"]) == {"claude", "codex"}
    assert all(stream["status"] == "done" for stream in result["workstreams"].values())
    merged = next(item for item in result["findings"] if item["file"] == "module.py")
    assert merged["severity"] == "critical"
    assert merged["agreement"] == "conflict"
    assert {position["tool"] for position in merged["positions"]} == {"claude", "codex"}
    assert {item["type"] for item in result["disagreements"]} >= {"severity", "presence"}
    panel_payload = json.loads(Path(result["panel_path"]).read_text(encoding="utf-8"))
    assert panel_payload["panel_id"] == result["panel_id"]
    assert result["panel_sha256"] == __import__("hashlib").sha256(Path(result["panel_path"]).read_bytes()).hexdigest()
    ledger = critic.read_panel_ledger(result["ledger_path"])
    assert ledger[-1]["record_type"] == "panel_run"
    assert ledger[-1]["panel_id"] == result["panel_id"]


def test_panel_partial_failure_is_inconclusive_not_clean(tmp_repo, monkeypatch):
    _commit_change(tmp_repo)
    monkeypatch.setitem(critic._ADAPTERS, "claude", _python_adapter([]))
    monkeypatch.setitem(critic._ADAPTERS, "codex", _python_adapter([], valid=False))
    result = critic.review_panel(base="HEAD^", timeout_seconds=10)
    assert result["status"] == "partial"
    assert result["verdict"] == "inconclusive"
    assert result["workstreams"]["claude"]["status"] == "done"
    assert result["workstreams"]["codex"]["status"] == "error"


def test_panel_empty_diff_is_clean_but_still_ledgered(tmp_repo):
    result = critic.review_panel(base="HEAD", head="HEAD")
    assert result["status"] == "done"
    assert result["verdict"] == "clean"
    assert result["findings"] == []
    assert all(stream["note"].startswith("empty diff") for stream in result["workstreams"].values())
    assert critic.read_panel_ledger(result["ledger_path"])[-1]["panel_id"] == result["panel_id"]


def test_panel_ledger_recovers_stale_lock_without_waiting_for_timeout(tmp_repo, monkeypatch):
    ledger_path = tmp_repo / "artifacts/harness/critic/stale-lock-ledger.jsonl"
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = ledger_path.with_name(ledger_path.name + ".lock")
    lock_path.write_text("4242\n", encoding="ascii")
    monkeypatch.setattr(critic, "_pid_is_alive", lambda pid: False)
    stale = time.time() - 120
    os.utime(lock_path, (stale, stale))
    monotonic_values = iter((0.0, 16.0))
    monkeypatch.setattr(critic.time, "monotonic", lambda: next(monotonic_values, 16.0))
    monkeypatch.setattr(critic.time, "sleep", lambda _seconds: None)

    record = critic._append_panel_ledger({"record_type": "test"}, path=ledger_path)

    assert record["record_type"] == "test"
    assert critic.read_panel_ledger(ledger_path) == [record]
    assert not lock_path.exists()
    assert not list(lock_path.parent.glob(lock_path.name + ".stale-*"))


def test_panel_ledger_never_steals_a_stale_lock_from_live_owner(tmp_repo):
    ledger_path = tmp_repo / "artifacts/harness/critic/live-owner-ledger.jsonl"
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = ledger_path.with_name(ledger_path.name + ".lock")
    lock_path.write_text(f"{os.getpid()}\n", encoding="ascii")
    stale = time.time() - 120
    os.utime(lock_path, (stale, stale))

    assert critic._recover_stale_panel_lock(lock_path) is False
    assert lock_path.read_text(encoding="ascii") == f"{os.getpid()}\n"


def test_panel_verdict_ledger_is_append_only_hash_chained(tmp_repo, monkeypatch):
    _commit_change(tmp_repo)
    finding = [{"severity": "major", "file": "module.py", "line": 1,
                "claim": "wrong result is returned", "evidence": "branch is inverted",
                "proposed_falsification_test": "exercise false branch"}]
    monkeypatch.setitem(critic._ADAPTERS, "claude", _python_adapter(finding))
    monkeypatch.setitem(critic._ADAPTERS, "codex", _python_adapter(finding))
    panel = critic.review_panel(base="HEAD^", timeout_seconds=10)
    finding_id = panel["findings"][0]["finding_id"]
    database = tmp_repo / "artifacts/harness/evidence.db"
    closure_artifact = tmp_repo / "artifacts/harness/verify/panel-regression.log"
    closure_artifact.parent.mkdir(parents=True, exist_ok=True)
    closure_artifact.write_text("verified regression\n", encoding="utf-8")
    connection = sqlite3.connect(database)
    try:
        connection.execute(
            "CREATE TABLE evidence ("
            "id TEXT PRIMARY KEY, status TEXT, invalidated_at TEXT, claim TEXT, notes TEXT, "
            "verifier TEXT, created_at TEXT, artifact_paths TEXT)"
        )
        connection.execute(
            "INSERT INTO evidence VALUES (?, 'verified', NULL, ?, '', 'pytest', "
            "'9999-01-01T00:00:00+00:00', ?)",
            ("ev-test-1", f"regression evidence for {finding_id}", json.dumps([str(closure_artifact)])),
        )
        connection.execute(
            "INSERT INTO evidence VALUES (?, 'unverified', NULL, ?, '', NULL, "
            "'9999-01-01T00:00:00+00:00', '[]')",
            ("ev-unverified", f"untrusted evidence for {finding_id}"),
        )
        connection.commit()
    finally:
        connection.close()
    disposition = critic.record_panel_verdict(
        panel["panel_id"], finding_id, "fixed", rationale="regression now passes",
        evidence_ids=["ev-test-1"], verifier="pytest regression",
    )
    records = critic.read_panel_ledger(panel["ledger_path"])
    assert [record["record_type"] for record in records[-2:]] == ["panel_run", "finding_disposition"]
    assert records[-1] == disposition
    assert records[-1]["previous_record_sha256"] == records[-2]["record_sha256"]
    with pytest.raises(ValueError, match="unknown panel_id"):
        critic.record_panel_verdict("missing-panel", finding_id, "open", rationale="", evidence_ids=[], verifier="")
    with pytest.raises(ValueError, match="does not belong"):
        critic.record_panel_verdict(panel["panel_id"], "missing-finding", "open", rationale="", evidence_ids=[], verifier="")
    with pytest.raises(ValueError, match="live verified"):
        critic.record_panel_verdict(panel["panel_id"], finding_id, "fixed", rationale="x", evidence_ids=["ev-fake"], verifier="fake")
    with pytest.raises(ValueError, match="live verified"):
        critic.record_panel_verdict(
            panel["panel_id"], finding_id, "fixed", rationale="x",
            evidence_ids=["ev-unverified"], verifier="fake",
        )
    with pytest.raises(ValueError, match="require rationale"):
        critic.record_panel_verdict(panel["panel_id"], finding_id, "rebutted",
                                    rationale="", evidence_ids=[], verifier="")
    ledger_path = Path(panel["ledger_path"])
    original = ledger_path.read_text(encoding="utf-8")
    ledger_path.write_text(original.replace('"verdict":"action_required"', '"verdict":"clean"', 1), encoding="utf-8")
    with pytest.raises(ValueError, match="hash mismatch"):
        critic.read_panel_ledger(ledger_path)


def test_panel_verdict_requires_finding_linked_post_panel_evidence(tmp_repo, monkeypatch):
    _commit_change(tmp_repo)
    finding = [{
        "severity": "major",
        "file": "module.py",
        "line": 1,
        "claim": "wrong result is returned",
        "evidence": "branch is inverted",
        "proposed_falsification_test": "exercise false branch",
    }]
    monkeypatch.setitem(critic._ADAPTERS, "claude", _python_adapter(finding))
    monkeypatch.setitem(critic._ADAPTERS, "codex", _python_adapter(finding))
    panel = critic.review_panel(base="HEAD^", timeout_seconds=10)
    finding_id = panel["findings"][0]["finding_id"]
    database = tmp_repo / "artifacts/harness/evidence.db"
    closure_artifact = tmp_repo / "artifacts/harness/verify/panel-regression.log"
    closure_artifact.parent.mkdir(parents=True, exist_ok=True)
    closure_artifact.write_text("verified regression\n", encoding="utf-8")
    connection = sqlite3.connect(database)
    try:
        connection.execute(
            "CREATE TABLE evidence ("
            "id TEXT PRIMARY KEY, status TEXT, invalidated_at TEXT, claim TEXT, notes TEXT, "
            "verifier TEXT, created_at TEXT, artifact_paths TEXT)"
        )
        rows = [
            ("ev-unrelated-late", "verified", None, "an unrelated verified claim", "", "pytest", "9999-01-01T00:00:00+00:00", "[]"),
            ("ev-linked-old", "verified", None, "old claim", f"covers {finding_id}", "pytest", "1900-01-01T00:00:00+00:00", "[]"),
            ("ev-panel-linked-late", "verified", None, "generic panel administration", "", "pytest", "9999-01-01T00:00:00+00:00", json.dumps([panel["panel_id"]])),
            ("ev-finding-linked-late", "verified", None, "finding closure", f"covers {finding_id}", "pytest", "9999-01-01T00:00:00+00:00", json.dumps([str(closure_artifact)])),
            ("ev-empty-artifacts", "verified", None, "finding closure", f"covers {finding_id}", "pytest", "9999-01-01T00:00:00+00:00", "[]"),
            ("ev-missing-artifact", "verified", None, "finding closure", f"covers {finding_id}", "pytest", "9999-01-01T00:00:00+00:00", json.dumps([str(tmp_repo / "missing.log")])),
        ]
        connection.executemany("INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
        connection.commit()
    finally:
        connection.close()

    with pytest.raises(ValueError, match="reference the finding_id"):
        critic.record_panel_verdict(
            panel["panel_id"], finding_id, "rebutted", rationale="unrelated",
            evidence_ids=["ev-unrelated-late"], verifier="pytest",
        )
    with pytest.raises(ValueError, match="created at or after"):
        critic.record_panel_verdict(
            panel["panel_id"], finding_id, "fixed", rationale="too old",
            evidence_ids=["ev-linked-old"], verifier="pytest",
        )
    with pytest.raises(ValueError, match="reference the finding_id"):
        critic.record_panel_verdict(
            panel["panel_id"], finding_id, "fixed", rationale="generic panel row",
            evidence_ids=["ev-panel-linked-late"], verifier="pytest",
        )
    with pytest.raises(ValueError, match="existing artifact files"):
        critic.record_panel_verdict(
            panel["panel_id"], finding_id, "fixed", rationale="no artifacts",
            evidence_ids=["ev-empty-artifacts"], verifier="pytest",
        )
    with pytest.raises(ValueError, match="existing artifact files"):
        critic.record_panel_verdict(
            panel["panel_id"], finding_id, "fixed", rationale="missing artifact",
            evidence_ids=["ev-missing-artifact"], verifier="pytest",
        )

    accepted = critic.record_panel_verdict(
        panel["panel_id"], finding_id, "fixed", rationale="linked and fresh",
        evidence_ids=["ev-finding-linked-late"], verifier="pytest",
    )
    assert accepted["evidence_records"][0]["id"] == "ev-finding-linked-late"
    assert accepted["evidence_records"][0]["verifier"] == "pytest"


def test_panel_requires_distinct_supported_tools(tmp_repo):
    with pytest.raises(ValueError, match="distinct"):
        critic.review_panel(tools=("claude", "claude"))
    with pytest.raises(ValueError, match="unsupported"):
        critic.review_panel(tools=("claude", "other"))



def test_panel_snapshot_links_are_neutralized_not_followed(tmp_path):
    outside_file = tmp_path / "outside.txt"
    outside_file.write_text("secret", encoding="utf-8")
    outside_dir = tmp_path / "outside-dir"
    outside_dir.mkdir()
    (outside_dir / "nested.txt").write_text("nested secret", encoding="utf-8")
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    file_link = snapshot / "file-link"
    dir_link = snapshot / "dir-link"
    try:
        file_link.symlink_to(outside_file)
        dir_link.symlink_to(outside_dir, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation unavailable")
    count = critic._neutralize_snapshot_links(snapshot)
    assert count == 2
    assert file_link.is_file() and not file_link.is_symlink()
    assert dir_link.is_file() and not dir_link.is_symlink()
    assert "SYMLINK NOT FOLLOWED" in file_link.read_text(encoding="utf-8")
    assert "SYMLINK NOT FOLLOWED" in dir_link.read_text(encoding="utf-8")
    assert outside_file.read_text(encoding="utf-8") == "secret"
    assert (outside_dir / "nested.txt").read_text(encoding="utf-8") == "nested secret"



def test_single_review_rejects_nonzero_even_with_parseable_empty_array(tmp_repo, monkeypatch):
    _commit_change(tmp_repo)
    command = [sys.executable, "-c", "import sys; print('[]'); sys.exit(7)"]
    monkeypatch.setattr(critic, "load_config", lambda: {"critic": {"command": command, "timeout_seconds": 10}})
    result = critic.review("SENSITIVE-QUESTION", base="HEAD^")
    assert result["status"] == "error"
    assert "nonzero" in result["reason"]
    raw = Path(result["raw_output_path"]).read_text(encoding="utf-8")
    assert "SENSITIVE-QUESTION" not in raw
    assert "<prompt sha256=" in raw


def test_single_review_rejects_invalid_finding_schema(tmp_repo, monkeypatch):
    _commit_change(tmp_repo)
    command = [sys.executable, "-c", "print('[{\\\"severity\\\":\\\"banana\\\"}]')"]
    monkeypatch.setattr(critic, "load_config", lambda: {"critic": {"command": command, "timeout_seconds": 10}})
    result = critic.review(base="HEAD^")
    assert result["status"] == "error"
    assert "invalid findings schema" in result["reason"]


def test_exact_panel_identity_never_fuzzy_merges_negated_claims():
    base = {"severity": "major", "file": "a.py", "line": 7,
            "evidence": "branch", "proposed_falsification_test": "exercise branch"}
    workstreams = {
        "claude": {"status": "done", "findings": [{**base, "claim": "validator accepts invalid input"}]},
        "codex": {"status": "done", "findings": [{**base, "claim": "validator does not accept invalid input"}]},
    }
    findings, disagreements = critic._normalize_panel_findings(workstreams, ["claude", "codex"])
    assert len(findings) == 2
    assert all(item["agreement"] == "single-tool" for item in findings)
    assert any(item["type"] == "possible_overlap_unmerged" for item in disagreements)


def test_panel_detects_persistent_snapshot_mutation(tmp_repo, monkeypatch):
    _commit_change(tmp_repo)
    clean = _python_adapter([])
    mutating_code = "from pathlib import Path; Path('module.py').write_text('changed'); print('[]')"
    monkeypatch.setitem(critic._ADAPTERS, "claude", clean)
    monkeypatch.setitem(critic._ADAPTERS, "codex", lambda prompt: [sys.executable, "-c", mutating_code, prompt])
    result = critic.review_panel(base="HEAD^", timeout_seconds=10)
    assert result["status"] == "partial"
    assert result["verdict"] == "inconclusive"
    assert "freeze violation" in result["workstreams"]["codex"]["reason"]


def test_same_second_single_empty_reviews_use_distinct_artifacts(tmp_repo):
    first = critic.review(tool="claude", base="HEAD", head="HEAD")
    second = critic.review(tool="claude", base="HEAD", head="HEAD")
    assert first["findings_path"] != second["findings_path"]



def test_panel_ledger_hard_stale_escape_recovers_live_or_unknown_pid(tmp_repo, monkeypatch):
    ledger_path = tmp_repo / "artifacts/harness/critic/hard-stale-ledger.jsonl"
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = ledger_path.with_name(ledger_path.name + ".lock")
    for owner_state in (True, None):
        lock_path.write_text(f"{os.getpid()}\n", encoding="ascii")
        stale = time.time() - critic.PANEL_LEDGER_HARD_STALE_SECONDS - 1
        os.utime(lock_path, (stale, stale))
        monkeypatch.setattr(critic, "_panel_lock_owner_alive", lambda _path, state=owner_state: state)
        assert critic._recover_stale_panel_lock(lock_path) is True
        assert not lock_path.exists()


def test_extract_rejects_truncated_or_quoted_fallback_candidates():
    real = json.dumps([{
        "severity": "major", "file": "module.py", "claim": "real",
        "evidence": "e", "proposed_falsification_test": "t",
    }])
    assert critic._extract_json_array(f"repository quoted []\nactual review: {real[:-1]}") is None
    assert critic._extract_json_array("repository documentation contains []") is None
    assert critic._extract_json_array(f"repository quoted {real}\ncritic did not finish") is None
