# PR performance benchmarks

Each push to an open, vouched PR starts an informational Prime Agent benchmark. Multiple commits in
one push produce one run for the final head. Draft PRs are included. A 60-second debounce and
per-PR cancellation avoid finishing obsolete runs. `workflow_dispatch` reruns an open PR by number.
Identical automatic requests reuse the completed comment when both SHAs, harness, model, prices, and
configuration match. Manual dispatch and GitHub reruns force fresh measurements. Unvouched authors
receive a pending-trust comment; a maintainer can rerun after vouching.

The controller resolves current `main` and the PR head to full SHAs, builds both in separate Prime
sandboxes, and alternates their measurements. Both use the same trusted harness revision, image
digest, resource allocation, model, and reasoning effort. No performance gate blocks merging.

## Enable in GitHub

Add these repository secrets:

- `PRIME_SANDBOX_API_KEY`: a dedicated key with Sandbox permissions for provisioning and cleanup.
- `PINFERENCE_API_KEY`: a dedicated key with **Inference-only** permission. Prime Sandboxes injects
  this through its encrypted `secrets` field as `PRIME_API_KEY`, which the built-in `prime-inference`
  provider reads directly. No proxy or provider implementation changes are involved.

Optional repository variables:

- `PRIME_BENCHMARK_TEAM_ID`: workspace used for sandbox and inference billing.
- `PINFERENCE_BENCHMARK_MODEL`: defaults to `openai/gpt-5.6-terra`. Use a public, stable Pinference model
  supported by both revisions. Model retirement produces a visible failure, never a silent fallback.

The workflows must first land on `main`: both `pull_request_target` and the completion listener run
trusted default-branch code. Trigger `Prime Agent benchmarks` manually with an open PR number after
configuring the secrets. The first rollout should include a main-versus-main calibration.

PR code can read the inference token inside its sandbox. Use the existing Vouch trust gate and a
dedicated token with an account-side spending limit. The sandbox control key and GitHub token stay on
the trusted controller; a separate publisher owns GitHub comment write permission. No PR checkout,
build script, installer, executable, or archive is executed/extracted on a privileged GitHub runner.

## Measurements

The default configuration uses two Linux x64 containers, each with 4 vCPU, 8 GB RAM, and 20 GB disk.
`config.json` pins the image and sampling policy. Harness dependencies are locked with a seven-day
release cutoff. Provisioning, harness setup, and source compilation have separate recorded durations
outside the timed installation interval. Interactive runs use the same small committed Git fixture.

- **Cold startup:** process launch until the editor visibly echoes a typed marker, after stopping all
  processes owned by the benchmark user. OS filesystem caches are not flushed.
- **Warm startup:** the same input-ready measurement while retaining the daemon and stopping its
  previous active sessions. Each TUI launch opens a fresh conversation.
- **TTFT:** Enter until the first visible character of the assistant's expected answer, excluding
  echoed input, status text, and thinking. The fixed prompt asks for the uppercase form of `quartz`.
  The completed session must contain exactly `QUARTZ`; mismatches/timeouts remain failed samples.
  The built-in Pinference provider runs with medium effort and a 1,024-token output limit.
- **Installation:** the normal installer and Python/tool bootstrap in three new user homes, each
  with empty npm and uv caches. Unpublished candidate release tarballs are served over loopback;
  npm/Python dependencies use the real network. This does not measure public release-CDN latency.
- **Compressed artifacts:** total bytes of the four tarballs produced by the release packer, using
  an identical synthetic version and download origin for both sides. External registry dependencies
  are not included in these tarballs.
- **Installed footprint:** apparent bytes added after first use in the first fresh home, including stock Python,
  runtime, and tool assets; excluding download caches, session history, and logs. Shared system
  dependencies supplied by the base image and the fixture repository are excluded.
- **Idle memory:** summed RSS across the benchmark user's entire process tree after input readiness
  and a one-second settle. Raw results include each process and PSS when Linux permits reading it.
  The controller, PTY harness, artifact server, and build user are excluded. RSS can double-count
  shared pages.

Startup, TTFT, and memory use 10 trials per revision. Installation uses three; sizes are measured
once. Stock tools, skills, prompts, daemon, persistence, and Python bootstrap remain enabled. Fresh
homes contain no personal credentials, extensions, MCP servers, or custom skills. Only the dedicated
Pinference credential and optional billing team are supplied.

The comment shows medians, signed absolute/percentage deltas, successful/attempted counts, and spread.
`↓` means improvement, bold `↑` means regression, `≈` means no clear change, and `—` means unavailable
or incomplete. Arrows require a change larger than the metric's provisional absolute/relative floor
and observed spread. This is a practical noise filter, not a statistical significance test. Inspect
raw trials before acting on small changes; provider load and caches remain external sources of noise.

## Lifecycle and costs

The main workflow posts a single marked comment and updates it in place. The completion workflow
publishes the final result or a cancellation/failure notice. Publishers serialize by PR and check the
current head, latest run ID, attempt, and existing comment generation before writing. A rerun of an
older commit cannot overwrite a newer result, including when the newer run has the same head SHA.

Results and logs are retained as GitHub artifacts for 14 days. They include exact source and harness
SHAs, environment details, installed dependency inventory, transcripts, raw observations, failures,
and estimated costs. Normalized session usage exposes input, output, and cached tokens; a separate
reasoning-token count and an authoritative billed cost are unavailable, so neither is fabricated.
The publisher validates schema, identity, finite numbers, and report size and
escapes sandbox-provided text.

The controller stops scheduling work at 20 minutes or its $1 estimated budget target. Every sandbox
has a 30-minute TTL. Teardown runs in `finally`; the independent completion workflow deletes any
remaining sandboxes with the exact repository/run/attempt labels, including after cancellation.
Cleanup enumerates all pages before deleting so pagination cannot skip a sandbox.

At the configured list rates, two sandboxes cost about $0.01/minute together. A 10-minute run costs
about $0.10 in sandbox compute. Twenty prompts at 5,000 input and 250 output tokens each cost about
$0.325 with the default model's September 2026 catalog rates ($2.50/$15 per million tokens), before
cache discounts. Actual token usage and sandbox lifetime are recorded. The $1 target is **not** a
hard billing cap: provider retries without final usage, cancellation latency, and direct-token use
can exceed estimates. Do not substitute a broad personal account token for the CI inference key.

## Local development

Run the isolated harness checks from this directory:

```sh
uv sync --locked
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked python -m unittest discover -s tests -v
```

Tests use fake GitHub/SDK responses and terminal streams; they never invoke inference or provision
sandboxes. A live run is separate and requires explicitly supplied `PRIME_SANDBOX_API_KEY` and
`PINFERENCE_API_KEY` environment variables:

```sh
uv run --locked cli.py local --base FULL_MAIN_SHA --head FULL_HEAD_SHA --results results/local
```

Use identical SHAs to calibrate main against itself. `--config /path/to/config.json` can reduce trials
for a smoke run; the report records the effective configuration. Local mode never posts GitHub
comments. `results/`, `.venv/`, and `.ruff_cache/` are ignored. Run the repository's `npm run check`
after code changes as well.
