# checks/invariants

Pytest suites asserting the *physical/mathematical invariants* of your code:
conservation laws (energy, momentum, symplectic form), symmetries
(time-reversibility, gauge/parameterization invariance), dimensional
consistency, and domain/assumption guards for symbolic code.

Conventions:

- One file per subsystem (`test_hamiltonian_invariants.py`, ...).
- Use `sci_verify.check_invariant` / `check_convergence` helpers inside tests
  where useful, or plain asserts — either way the gate runs them via pytest.
- Every invariant states its regime in the test docstring (step size, horizon,
  precision) — an invariant without a regime is a future false alarm.

This directory is wired into `harness/manifest.json` as a conditional check
triggered by changes under `src/symbolic/**` (edit the globs to your layout).
