# Short SWE pre-release check

This evaluation compares the exact PR base and exact PR head on 28 fixed tasks:
15 SWE-bench Verified, 8 SWE-bench Pro, and 5 ScaleSWE. It uses
`internal/glm-5.3-fast` with `autonomous = false`.

The workflow runs only for a `pull_request_target` `labeled` event whose label is
exactly `pre-release`. Applying the label approves that head only. A later commit
has no passing check and requires the label to be removed and applied again.

## Trust boundary

- The workflow and evaluator come from the trusted base branch.
- Exact base and head source revisions build as an unprivileged user in separate
  Prime sandboxes.
- The runner copies only bounded opaque npm tarballs from a root-owned snapshot.
  It never extracts or executes candidate packages.
- Verifiers uploads those packages into isolated task sandboxes. Candidate code
  receives no GitHub, provider, or sandbox credentials.
- The three tasksets and both comparison sides launch concurrently. There is no
  shared client-side model-request limit.
- Typed Verifiers `WireTrace` episodes provide rewards, usage, timing, and task
  identity. Missing or malformed episodes fail. Exact rollout deadlines and deterministic
  provider rejections remain unresolved model outcomes; transient provider failures fail.
- There is no durable baseline, promotion job, focused confirmation, or automatic
  retry. The one run compares head directly with its exact base and never merges.

## Gate

The check fails if it cannot validate all 28 paired tasks. It also fails for a
loss of at least five resolved tasks, three additional model failures, or a 2x
output-token or end-to-end-time increase without a resolution gain. Smaller changes remain visible in the report.
Meaningful token changes (20% or more) use green for reductions and red for
increases.

## Model-free validation

```sh
uv run --locked --project scripts/benchmarks ruff check --config scripts/benchmarks/pyproject.toml scripts/evals/short_swe
uv run --locked --project scripts/benchmarks ruff format --config scripts/benchmarks/pyproject.toml --check scripts/evals/short_swe
uv run --locked --project scripts/benchmarks pytest -q scripts/evals/short_swe/tests
```
