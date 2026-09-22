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

The paid evaluation runs only for a `pull_request_target` `labeled` event whose label is
exactly `pre-release`. The workflow marks the requested head pending before checkout and records
label approval in a separate status that the evaluation finisher never writes. Removing the label
revokes approval even if an in-flight evaluation later finishes. Head or default-branch changes
revoke both statuses. Evaluation success also requires repository rules to require both statuses
with strict up-to-date-branch enforcement, which closes races with a concurrent base update.
Reapply the label to approve the new exact comparison.

## Trust boundary

- The workflow and evaluator come from the trusted base branch.
- Exact base and head source revisions build as an unprivileged user in separate
  Prime sandboxes.
- The runner copies only bounded opaque npm tarballs from a root-owned snapshot.
  It never extracts or executes candidate packages.
- Verifiers uploads those packages into isolated task sandboxes. Candidate code
  receives no GitHub, provider, or sandbox credentials.
- The three tasksets and both comparison sides run as six private hosted evaluations on
  Prime Evals, launched concurrently. Each evaluation runs the published `short-swe-*`
  Environments Hub packages, which embed the fixed slices, pinned datasets, evaluation
  limits, and the candidate harness as package defaults. Each evaluation starts at most
  four root episodes, so the six-way launch has at most 24 root agents against the global
  provider concurrency limit of 32 shared across every session. Recursive subagents remain
  unrestricted; there is no shared client-side queue or semaphore. A terminal rollout
  timeout with any provider call error fails closed.
- The suite pins `internal/glm-5.3-fast` with `internal/deepseek-v4.1-flash` as its
  authorized backup for a saturated global limit. Every paired task must use exactly one
  pinned model, and base and head must use the same model; the gates fail otherwise.
- The candidate npm tarballs are delivered to each hosted evaluation through
  `CANDIDATE_TARBALLS_URL`, `CANDIDATE_COMMIT`, and `CANDIDATE_CHECKSUMS` secrets. The
  trusted harness downloads and checksum-verifies them before the agent starts, and those
  values never reach a candidate-controlled runtime. The platform's verifiers runtime is
  version-managed by Prime Evals; the packages accept `verifiers[harbor]>=0.3.1` and the
  gates validate every pulled episode with the pinned local evaluator.
- Hosted episodes are pulled back with `prime eval samples`; each sample carries the full
  native episode record, which the pinned evaluator validates with the same fail-closed
  gates as the local paired flow. The report links every hosted evaluation for durable
  evidence.
- Typed Verifiers `WireTrace` episodes provide rewards, usage, timing, and task
  identity. Missing or malformed episodes fail. Exact rollout deadlines and deterministic
  provider rejections remain unresolved model outcomes; terminal 5xx provider outages count as unresolved model outcomes bounded by the model-failure threshold.
- SWE-bench Verified transfers only a bounded binary source diff into a fresh, credential-free,
  network-free verifier sandbox. The trusted evaluator parses bounded controller-captured test
  output against pinned task metadata. The solver never receives the task package metadata; gold
  source patches and expected statuses are removed from the verifier before repository tests run.
  The fixed pure-Python slice uses dependencies already pinned in
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
