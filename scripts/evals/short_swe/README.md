# Short SWE pre-release check

This evaluation compares the exact PR base and exact PR head on 28 fixed tasks:
15 SWE-bench Verified, 8 SWE-bench Pro, and 5 ScaleSWE. It uses
`internal/glm-5.3-fast` with `autonomous = false`.

The fixed sample is repository-stratified rather than a prefix of dataset order. Verified
covers all 12 source repositories with a 6/7/1/1 split across the published difficulty
buckets (`<15 min`, `15 min–1 hour`, `1–4 hours`, and `>4 hours`). Pro uses one task from
each of eight repositories. Pro repositories and eligible tasks within each declared
repository/difficulty bucket were ranked with the fixed seed `prime-agent-short-swe-v2`.
Eligibility requires the pinned verifier tests to complete without external network access;
prompts and model outcomes were not inspected when choosing between eligible tasks.

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
- SWE-bench Verified transfers only a bounded binary source diff into a fresh, credential-free,
  network-free verifier sandbox. The trusted evaluator parses its bounded test log against pinned
  task metadata. Gold source patches and expected-status metadata are removed from the sandbox
  before candidate code runs. The fixed pure-Python slice uses dependencies already pinned in
  each task image, so scoring does not resolve packages from the network. A fixed gold-patch oracle must resolve
  before any paired task starts. Missing or inconsistent verifier output fails as infrastructure
  rather than becoming a zero reward.
- There is no durable baseline, promotion job, focused confirmation, or automatic
  retry. The one run compares head directly with its exact base and never merges.

## Gate

The check fails if it cannot validate all 28 paired tasks. It also fails for a
loss of at least five resolved tasks, three additional model failures, or a 2x
output-token or cumulative-task-time increase without a resolution gain. Cumulative task time
sums task traces, including tasks that overlap in wall-clock time. Smaller changes remain visible
in the report. Meaningful token changes (20% or more) use green for reductions and red for
increases.

## Model-free validation

```sh
uv run --locked --project scripts/benchmarks ruff check --config scripts/benchmarks/pyproject.toml scripts/evals/short_swe
uv run --locked --project scripts/benchmarks ruff format --config scripts/benchmarks/pyproject.toml --check scripts/evals/short_swe
uv run --locked --project scripts/benchmarks pytest -q scripts/evals/short_swe/tests
```
