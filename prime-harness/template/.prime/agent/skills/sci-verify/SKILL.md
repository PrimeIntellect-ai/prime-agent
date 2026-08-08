---
name: sci-verify
description: Deterministic scientific verification oracles — MANDATORY before claiming any mathematical or numerical result is correct and before completing any goal. symbolic_equivalence (SymPy, assumption-aware, numeric falsification), numeric_compare (precision-ladder reference comparison), check_convergence (observed order), check_invariant (conservation drift), property_suite (Hypothesis/pytest), run_suite (the composite gate, same command the autonomous gate runs). Every check writes full evidence to artifacts/harness/verify/ and returns a compact VerificationResult. An inconclusive result is NOT a pass.
---

# sci-verify

Rules this project enforces:

- **Symbolic equality requires explicit assumptions.** `sqrt(x**2) == x` is
  false without `{"x": "positive"}` — and `symbolic_equivalence` will find the
  counterexample and return `fail`.
- **Numerical agreement at one precision is not proof.** `numeric_compare`
  evaluates the reference on a 53/106/212-bit ladder and flags references that
  drift with precision.
- **Randomized checks record their seeds** (in the evidence artifact and the
  reproducibility command).
- **`inconclusive` must never be reported as `pass`.** Escalate: tighter
  assumptions, an independent oracle, or a formal proof.
- Full evidence goes to `artifacts/harness/verify/*.json`; put only the
  compact result in context and record verified claims in `evidence_ledger`.

```python
r = sci_verify.symbolic_equivalence("sqrt(x**2)", "x", {"x": "real positive"})
r = sci_verify.numeric_compare(my_func, "exp(-x**2/2)", cases=[{"x": 0.5}, {"x": 40.0}])
r = sci_verify.check_convergence(errors=[...], resolutions=[16, 32, 64, 128], expected_order=4)
r = sci_verify.check_invariant(energy_series, rtol=1e-8, name="total energy")
r = sci_verify.property_suite()                 # checks/properties via pytest
r = sci_verify.run_suite("changed-files")      # the composite gate; also `await sci_verify()`
```

Check `r.status` ∈ pass | fail | inconclusive | error, `r.evidence`,
`r.warnings`, `r.artifact_paths`. On `pass`, record it:
`evidence_ledger.record(r.claim, status="verified", verifier=r.method, artifacts=r.artifact_paths, assumptions=r.assumptions)`.
