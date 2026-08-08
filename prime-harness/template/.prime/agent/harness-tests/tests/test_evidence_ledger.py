from __future__ import annotations

import json

import pytest

import evidence_ledger as ledger


def test_record_and_get(tmp_repo):
    eid = ledger.record("Energy drift is bounded for fixed step", status="verified",
                        verifier="sci_verify.check_invariant",
                        assumptions={"hamiltonian": "autonomous"}, confidence=0.9)
    row = ledger.get(eid)
    assert row is not None
    assert row["status"] == "verified"
    assert row["assumptions"] == {"hamiltonian": "autonomous"}
    assert row["commit_sha"]  # captured from git automatically


def test_verified_requires_verifier(tmp_repo):
    with pytest.raises(ValueError, match="verifier"):
        ledger.record("claim", status="verified")


def test_invalid_status_rejected(tmp_repo):
    with pytest.raises(ValueError, match="status"):
        ledger.record("claim", status="definitely-true")


def test_search_default_excludes_refuted_and_invalidated(tmp_repo):
    good = ledger.record("adaptive stepping breaks symplectic behavior",
                         status="verified", verifier="test")
    ledger.record("adaptive stepping is always fine", status="refuted", verifier="test")
    dead = ledger.record("adaptive stepping needs review", status="verified", verifier="test")
    ledger.invalidate(dead, "superseded by better analysis")

    hits = ledger.search("adaptive stepping")
    ids = [h["id"] for h in hits]
    assert good in ids
    assert len(ids) == 1  # refuted + invalidated filtered out


def test_search_by_id_and_all_statuses(tmp_repo):
    eid = ledger.record("special claim xyzzy", status="inconclusive")
    assert ledger.search(eid)[0]["id"] == eid
    assert any(h["id"] == eid for h in ledger.search("xyzzy", status=None))


def test_fts_injection_safe(tmp_repo):
    ledger.record("innocent claim", status="unverified")
    # FTS5 syntax in the query must not raise or match everything
    assert isinstance(ledger.search('claim" OR x NEAR/2 ("', status=None), list)


def test_invalidate_requires_reason_and_is_sticky(tmp_repo):
    eid = ledger.record("to be removed", status="unverified")
    with pytest.raises(ValueError):
        ledger.invalidate(eid, "   ")
    row = ledger.invalidate(eid, "contradicted by run 42")
    assert row["invalidated_at"] is not None
    with pytest.raises(KeyError):
        ledger.invalidate(eid, "twice")


def test_ingest_maps_statuses_without_trusting_self_attestation(tmp_repo, tmp_path):
    artifact = tmp_path / "result.json"
    artifact.write_text(json.dumps({
        "task": "verify integrator order", "status": "pass",
        "method": "convergence-order", "assumptions": {"step": "fixed"},
        "evidence": {"observed_order": 4.01},
    }), encoding="utf-8")
    eid = ledger.ingest(artifact)
    row = ledger.get(eid)
    assert row["status"] == "unverified"
    assert row["verifier"] is None
    assert "reported_verifier" in row["notes"]
    assert str(artifact) in row["artifact_paths"]

    artifact.write_text(json.dumps({"task": "bad claim", "status": "counterexample_found"}), encoding="utf-8")
    assert ledger.get(ledger.ingest(artifact))["status"] == "refuted"

    artifact.write_text(json.dumps({
        "claim": "fabricated", "status": "pass", "method": "fake-verifier",
        "evidence": {"invented": True},
    }), encoding="utf-8")
    laundered = ledger.get(ledger.ingest(artifact))
    assert laundered["status"] == "unverified"
    assert laundered["verifier"] is None
    artifact.write_text(json.dumps({
        "claim": "self-attested verified claim",
        "status": "verified",
        "verifier": "untrusted-child",
    }), encoding="utf-8")
    quarantined = ledger.get(ledger.ingest(artifact))
    assert quarantined["status"] == "unverified"
    assert quarantined["verifier"] is None
    assert "self-attested verified remains unverified" in quarantined["notes"]

    with pytest.raises(ValueError, match="cannot create verified"):
        ledger.ingest(artifact, status_override="verified")


def test_stats_and_run(tmp_repo):
    ledger.record("alpha claim", status="verified", verifier="test")
    stats = ledger.run()
    assert stats["total"] >= 1
    assert ledger.run("alpha")            # search path (verified-only default)
    assert ledger.search("alpha", status=None)
