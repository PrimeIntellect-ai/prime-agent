---
name: evidence-ledger
description: Canonical provenance-bearing store of scientific claims for this project (SQLite+FTS at artifacts/harness/evidence.db). Use record() after every verification outcome, search() BEFORE re-deriving or re-asserting any prior claim, invalidate() when new evidence contradicts a record, and ingest() to import sci_verify results, child result JSONs, or critic findings. Records carry status (verified/refuted/inconclusive/unverified/superseded), assumptions, commit SHA, verifier, artifacts, and confidence. A 'verified' record requires naming its verifier. Call `await evidence_ledger("query")` to search.
---

# evidence-ledger

Discipline:

- **Search before re-deriving.** `evidence_ledger.search("energy drift adaptive")`
  — the default returns only live, *verified* records. A similar-sounding but
  refuted claim will not outrank a verified one.
- **Record with provenance, not vibes.** `record(claim, status=..., verifier=...,
  assumptions=..., artifacts=[...], confidence=...)`. Commit SHA is captured
  automatically. `status="verified"` without a named verifier raises.
- **Never delete — invalidate.** `invalidate(id, reason)` keeps history and
  removes the record from default retrieval.
- **Ingest artifacts instead of retyping.** `ingest(path)` maps a sci_verify
  result, child result JSON, or critic findings file into a record that points
  back at the artifact. A pass becomes verified only when it carries a named
  verification method/verifier and nonempty structured evidence; otherwise it
  remains unverified. Fail/counterexample becomes refuted and error becomes
  inconclusive.
- Scope claims by regime: put domain limits in `assumptions`, not prose.

```python
eid = evidence_ledger.record(
    "Solver X loses symplectic energy behavior when adaptive stepping is enabled",
    status="verified", verifier="sci_verify.check_invariant",
    assumptions={"hamiltonian": "autonomous", "test": "canonical pendulum"},
    artifacts=["artifacts/harness/verify/...json"], confidence=0.94)
evidence_ledger.search("adaptive stepping", status=None)   # all statuses
evidence_ledger.stats()
```
