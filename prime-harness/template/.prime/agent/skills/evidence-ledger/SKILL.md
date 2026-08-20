---
name: evidence-ledger
description: Canonical provenance-bearing store of scientific claims for this project (SQLite+FTS at artifacts/harness/evidence.db). Use record() after every executed verification outcome, search() BEFORE re-deriving or re-asserting any prior claim, invalidate() when new evidence contradicts a record, and ingest() to quarantine untrusted sci_verify-shaped, child-result, or critic JSON as non-verified provenance. Records carry status (verified/refuted/inconclusive/unverified/superseded), assumptions, commit SHA, verifier, artifacts, and confidence. A 'verified' record requires an explicit record() call naming the verifier. Call `await evidence_ledger("query")` to search.
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
- **Ingest artifacts without trusting them.** `ingest(path)` maps a sci_verify-
  shaped result, child result JSON, or critic findings file into a record that
  points back at the artifact. Artifact fields are self-attested: a pass always
  remains unverified even when it claims a method and structured evidence.
  After actually running the verifier, create the verified record explicitly
  with `record(..., status="verified", verifier="...")`. An ingest override
  cannot promote to verified. Fail/counterexample maps to refuted and error to
  inconclusive, preserving the artifact as a falsification lead rather than a
  trusted verdict.
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
