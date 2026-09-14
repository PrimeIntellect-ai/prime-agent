# Behavioral evaluation CI

This directory implements the label-gated Short SWE release check. It evaluates an
exact PR revision and compares it with the latest promoted behavioral reference.
The required status name is `Behavioral Eval / pre-release`.

## Workflows and scripts

- `.github/workflows/behavioral-evals.yml` resolves the event, checks contributor
  trust, builds the candidate, runs Short SWE, compares results, and requests a
  focused confirmation when needed.
- `.github/workflows/behavioral-evals-completed.yml` publishes one marker-based PR
  comment from validated artifacts, then deletes sandboxes owned by that run.
- `.github/workflows/behavioral-evals-promote.yml` promotes a passing result after
  its labeled PR merges.
- `ci.py` creates the trusted request. `build_controller.py` and `builder.py` build
  the PR revision in a dedicated Prime sandbox. `prepare.py` creates Verifiers
  configs. `evaluate.py` runs and extracts results. `assemble.py` compares and
  renders them. `confirm.py` performs paired reruns. `promote.py` validates release
  assets. `release.py` resolves and validates immutable baseline generations.
  `cleanup.py` removes run-owned sandboxes.
- `prime_agent_candidate.py` is the trusted Verifiers harness that installs the
  candidate packages inside each task sandbox. `trace_analyzer.py` extracts bounded,
  deterministic facts from observable trace events.

All workflow code and evaluator code come from the trusted base or default branch.
The PR revision is fetched only by the isolated builder. Merge these files to `main`
before using the check on another PR.

## Trigger and lifecycle

`behavioral-evals.yml` uses `pull_request_target` for PRs into `main`. It responds to
`opened`, `synchronize`, `reopened`, `ready_for_review`, `labeled`, and `unlabeled`.

A paid run starts only when both conditions are true:

1. A maintainer applies the exact `pre-release` label to the current, non-draft head.
2. Vouch reports that the PR author is trusted.

An unlabeled or draft PR passes without building or evaluating the candidate. An
untrusted labeled PR records a waiting-for-trust comment and fails the check. Any new
head or other PR lifecycle event invalidates the label approval and fails without paid
compute. Remove and reapply `pre-release` after reviewing the exact current head. The
per-PR concurrency group cancels its older run.

The completion workflow publishes a result only if the request matches the completed
run, the PR still points to the tested head revision, and the label is still present.
This prevents an old run from overwriting a newer comment.

## Fixed 28-task contract

`short-swe.json` is the canonical contract. `prepare.py` requires 28 unique tasks in
fixed slices of 15, 8, and 5. `evaluate.py` rejects missing, extra, or duplicate trace
task identities.

The run settings are:

```text
model: deepseek/deepseek-v4-flash
num_rollouts: 1
max_concurrent: 10 per taskset
autonomous: false
agent network policy: framework-only after trusted setup
Harbor version recorded by the manifest: 0.21.0
```

The three tasksets run as independent evaluator processes. Each process gets its own
`max_concurrent = 10`; the controller does not add a shared client-side admission
limit. Prime Agent autonomous mode is disabled in the manifest, trusted request,
generated TOML, result identity schema, and candidate harness validation. Task setup
has egress for trusted provisioning. Before the candidate starts, Verifiers switches
the sandbox to framework-only networking and keeps only interception and tool routes.

The source pins are:

<!-- markdownlint-disable MD013 -->

```text
Verifiers revision: 9df6a3c01bb640c34380f4f6dff63a1b168dee22
environments revision: a41660014674ba43d56ed054199dde25ddf69946
SWE-bench Verified dataset: swe-bench/swe-bench-verified@sha256:b934b0cc3dc800fe945eaf9f1623329db97ee3133c706d20644524c7759fb341
SWE-bench Pro dataset: scale-ai/swe-bench-pro@sha256:88411d32ff27e53a4c1a7e29f0c2aeba180c8e5d60f221cab5ed56325f33549d
ScaleSWE dataset: PrimeIntellect/Scale-SWE-Verified
ScaleSWE dataset revision: 8935f8e55244fd56080cdb8dcd0819a57e8a003c
```

The workflow installs Verifiers with its lock file and the `harbor` extra. During
config generation, `prepare.py` verifies both repository revisions, applies the two
SWE dataset digest pins, and adds the ScaleSWE revision to `load_dataset`.

### SWE-bench Verified, 15 tasks

```text
astropy__astropy-12907
astropy__astropy-13033
astropy__astropy-13236
astropy__astropy-13398
astropy__astropy-13453
astropy__astropy-13579
astropy__astropy-13977
astropy__astropy-14096
astropy__astropy-14182
astropy__astropy-14309
astropy__astropy-14365
astropy__astropy-14369
astropy__astropy-14508
astropy__astropy-14539
astropy__astropy-14598
```

### SWE-bench Pro, 8 tasks

```text
instance_ansible__ansible-0ea40e09d1b35bcb69ff4d9cecf3d0defa4b36e8-v30a923fb5c164d6cd18280c02422f75e611e8fb2
instance_ansible__ansible-0fd88717c953b92ed8a50495d55e630eb5d59166-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
instance_ansible__ansible-106909db8b730480615f4a33de0eb5b710944e78-v0f01c69f1e2528b935359cfe578530722bca2c59
instance_ansible__ansible-11c1777d56664b1acb56b387a1ad6aeadef1391d-v0f01c69f1e2528b935359cfe578530722bca2c59
instance_ansible__ansible-12734fa21c08a0ce8c84e533abdc560db2eb1955-v7eee2454f617569fd6889f2211f75bc02a35f9f8
instance_ansible__ansible-164881d871964aa64e0f911d03ae270acbad253c-v390e508d27db7a51eece36bb6d9698b63a5b638a
instance_ansible__ansible-185d41031660a676c43fbb781cd1335902024bfe-vba6da65a0f3baefda7a058ebbd0a8dcafb8512f5
instance_ansible__ansible-189fcb37f973f0b1d52b555728208eeb9a6fce83-v906c969b551b346ef54a2c0b41e04f632b7b73c2
```

<!-- markdownlint-enable MD013 -->

### ScaleSWE, 5 tasks

```text
auth0_auth0-python_pr671
beetbox_beets_pr3661
adamtheturtle_doccmd_pr42
arviz-devs_preliz_pr249
beetbox_beets_pr4386
```

## Baseline seed and promotion

The stable `behavioral-eval-baseline-v1` prerelease stores only a JSON pointer in its
body. The pointer selects an immutable
`behavioral-eval-reference-<run>-<attempt>` prerelease.
`release.py` downloads that generation and requires exactly `baseline.json`,
`provenance.json`, `artifact-manifest.json`, and the four candidate packages. It
validates the metadata, package names, sizes, digests, source revision, and candidate
fingerprint before comparison or confirmation.

Only an explicit 404 for the stable pointer enters `seed` mode. A corrupt pointer,
missing generation, partial asset set, integrity mismatch, or transient API failure
fails the check. Seed mode still requires a valid 28-task candidate result.

A PR run never writes the baseline. Promotion runs only after a labeled PR merges into
`main`. The newest matching run must be complete and successful. Promotion verifies the
request, tested head, recorded base and evaluator revisions, evaluator contract, report,
candidate fingerprint, and opaque packages. A comparison report must name the exact generation and candidate
fingerprint that are still current. A seed report is accepted only while no reference
exists. The promoter creates a run-attempt generation without clobbering existing
assets, downloads it again, and advances the stable pointer in one update. Generation
releases expire after 30 days; the selected generation is retained.

Each immutable generation contains:

```text
baseline.json
provenance.json
artifact-manifest.json
prime-agent-0.0.0-benchmark.tgz
prime-agent-ai-0.0.0-benchmark.tgz
prime-agent-core-0.0.0-benchmark.tgz
prime-agent-tui-0.0.0-benchmark.tgz
```

A manifest, builder, dependency lock, harness, extractor, or comparison change produces
a new evaluator-contract fingerprint and is intentionally incompatible with the old
baseline. Maintainers must explicitly retire the stable pointer before seeding a new
contract.

## Metrics and artifacts

For each task, `evaluate.py` extracts:

- resolution from positive weighted reward;
- provider output tokens summed from completion or output token usage;
- end-to-end seconds from trace timing spans;
- model-call and tool-call counts;
- model-induced timeout and infrastructure-error flags;
- deterministic trace fact counts and trace-completion state.

The PR comment shows resolution, provider output tokens, end-to-end seconds,
model-induced timeouts, infrastructure retries, and the aggregate number of counted
trace findings. `report.json` also contains model calls, tool calls, infrastructure errors,
and per-task comparison values. The extraction-only `trace_complete`
field remains in `results/candidate.json`. Raw traces, evaluator logs, generated
configs, and reports are retained as ordinary Actions artifacts for 30 days. Missing
tasks never count as wins because task identity validation rejects an incomplete
result.

Output tokens are the headline efficiency metric. Input caching and static prompt size
can differ between harness revisions.

## Thresholds and focused confirmation

With a baseline, the first comparison requests confirmation when any condition is met:

- resolved tasks decrease by at least 5 out of 28;
- model-induced timeouts increase by at least 3;
- aggregate provider output tokens are at least 2 times baseline, the baseline is
  nonzero, and resolution does not improve;
- aggregate end-to-end time is at least 2 times baseline, the baseline is nonzero, and
  resolution does not improve;
- a systemic `install`, `launch`, `acp`, `cpython`, `trace_integrity`, or `cleanup`
  failure is present in the candidate result.

`confirm.py` builds a narrowed manifest from the tasks attached to each finding. It
reruns the candidate and promoted baseline packages in parallel on that same subset.
Resolution and timeout findings use their paired discordant tasks, while ratio findings use
all 28 tasks. A reproduced finding changes the final status to `fail`. If every finding is rerun and does not reproduce,
the status becomes `pass`. A missing, partial, or failed confirmation remains `needs_confirmation` and writes an
`inconclusive` verdict. The required check then fails closed without calling the result
a confirmed behavioral regression, and the promoter rejects it.

Candidate tasks with a concrete pre-model infrastructure error are retried once before
comparison. A remaining infrastructure-invalid episode fails the run as infrastructure-invalid and
is never scored as an unresolved model outcome. Evaluator installation, candidate
build, and Short SWE command failures fail directly rather than entering threshold
confirmation. The extractor classifies observable install, launch, ACP, cpython, cleanup, and
trace-integrity stages. A stage becomes systemic only when every candidate task records
that stage. Ordinary trace findings are advisory and do not cross a failure threshold.

## Deterministic trace analysis

`trace_analyzer.py` reads observable assistant messages and tool events. It does not
inspect hidden chain-of-thought. Its default bounds are 5,000 events, 4,000 characters
per string, and 20 listed examples per fact. Counts are not truncated.

The analyzer produces facts for unsupported tool calls, tests after the final edit,
repeated identical commands, environment mutations, tool timeouts, failures without a
later successful retry, and test-success claims that conflict with earlier test status.
The evaluator carries these counts into its aggregate trace metric:

- unsupported tool calls;
- environment mutations;
- tool timeouts;
- ignored failures;
- claim mismatches;
- `no_test_after_final_edit` when an edit has no later test.

The evaluator also recognizes direct top-level `bash()` and `edit()` calls inside an
executed cpython cell for command, test, and edit sequencing. It does not infer calls in
dead branches or function bodies. Repeated-command groups and the detailed test/edit
fields remain available from the standalone analyzer and raw trace, but they are not
included in the aggregate count.
Pattern matches are review evidence, not correctness judgments. The standalone
`--check` option exits 1 for its documented violation subset and 2 for invalid input;
the CI evaluator calls the analyzer as a library and does not use that exit code.

## Trust and secret isolation

The `pull_request_target` runner never checks out or executes candidate source. The
trusted controller creates a dedicated builder sandbox, where an unprivileged user
fetches the exact PR revision, runs `npm ci`, and builds four release tarballs. The
builder sandbox is deleted in a `finally` block.

The runner treats candidate tarballs as opaque bytes. It accepts exactly four fixed
names, limits each file to 20 MB, and checks the recorded size and SHA-256 digest. The
trusted candidate harness uploads those bytes to each task sandbox, verifies their
digests there, and installs them there. It removes the upload staging directory after
installation.

`PRIME_SANDBOX_API_KEY` stays in trusted controller processes. Candidate build code
receives neither it nor `GITHUB_TOKEN`. The workflow maps the dedicated,
spend-capped `PRIME_BEHAVIORAL_API_KEY` to `PRIME_API_KEY` only in the trusted evaluator.
Verifiers keeps that key behind the ACP interception server.
`prime_agent_candidate.py` removes `PRIME_API_KEY` from both the
install environment and candidate process environment. The candidate process receives
the short-lived `PRIME_AGENT_INTERCEPT_KEY` instead. The trusted evaluator allows
independent model requests and enforces a 16 MB request-body cap, 128 model turns,
100,000 output tokens, 5,000,000 total tokens, and a 3,600-second rollout deadline. The
dedicated provider key supplies a separate account-level spend ceiling.

The evaluator job has read-only repository and Actions permissions. PR write permission
exists only in the separate completion workflow. That publisher validates the source
workflow, request identity, current PR head, current label, comment marker, and comment
size before it writes.

## Cleanup

Task sandboxes are labeled with repository, workflow run, attempt, and role. The
completion workflow runs cleanup after every completed evaluation, including failed or
cancelled runs. `cleanup.py` lists active sandboxes that match the exact repository,
run, and attempt labels, then deletes them. Run attempts cannot delete one another's
sandboxes.

Completion cleanup is best-effort and uses `continue-on-error`; it does not change the
already completed evaluation verdict. The builder's own `finally` deletion is separate.
Pinned Prime runtimes also retain their one-hour idle deletion policy as a fallback.

## Maintainer setup

After this code is on `main`, maintainers must:

1. Create the exact `pre-release` label.
2. Add repository Actions secrets `PRIME_SANDBOX_API_KEY` and a dedicated,
   spend-capped `PRIME_BEHAVIORAL_API_KEY`.
3. Add the repository Actions variable `PRIME_BENCHMARK_TEAM_ID` when the sandbox
   account requires a team. Workflows map it to `PRIME_TEAM_ID` for the scripts.
4. Configure the repository's Vouch trust policy and approval process.
5. Allow the promotion workflow's `GITHUB_TOKEN` to write release contents and the
   completion workflow to write PR comments.
6. Require `Behavioral Eval / pre-release` in the branch ruleset.
7. Label and merge the first valid release candidate. Its seed result creates the first
   reference automatically.

## Local validation

Install the locked controller environment, then run the comparison and trace tests:

```bash
uv sync --locked --project scripts/benchmarks
cd scripts/behavioral-evals
uv run --locked --project ../benchmarks \
  python -m unittest tests.test_evaluation tests.test_trace_analyzer -v
python3 -m json.tool short-swe.json >/dev/null
```

This test command does not import the Verifiers harness. To run all tests, first create
`vendor/verifiers` at the revision in `short-swe.json` and perform the workflow's
`uv sync --locked --project vendor/verifiers --extra harbor` step. Then run:

```bash
cd scripts/behavioral-evals
../../vendor/verifiers/.venv/bin/python -m unittest discover -s tests -t . -v
```

A live Short SWE run requires the configured Prime credentials and incurs inference and
sandbox cost. Do not use it as a local unit-test command.
