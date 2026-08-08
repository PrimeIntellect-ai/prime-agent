# checks/reference_cases

Pytest suites comparing implementations against independent references:
analytic solutions, high-precision oracles (`sci_verify.numeric_compare`
precision ladder), independently implemented solvers, or published tables
(with source + version recorded in the test docstring).

Rules:

- The reference must be *independent* — a reference sharing the same code
  path as the implementation verifies nothing (shared-oracle bug).
- Agreement at float64 alone is weak evidence; prefer the precision ladder.
- Convergence studies live here too: assert observed order via
  `sci_verify.check_convergence`, not eyeballed log-log plots.

Wired into `harness/manifest.json` as a conditional check for
`src/simulation/**` and `src/integrators/**` changes (edit to your layout).
