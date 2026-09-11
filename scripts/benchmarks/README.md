# PR performance benchmarks

Each push to an open, vouched PR starts an informational Prime Agent benchmark, including PRs targeting
another branch in a stack. Multiple commits in one push produce one run for the final head. Draft PRs
are included. A two-second debounce and per-PR cancellation avoid finishing obsolete runs.
`workflow_dispatch` reruns an open PR by number.
Identical automatic requests reuse the completed comment when both SHAs, harness, and configuration
match. Manual dispatch and GitHub reruns force fresh measurements. Unvouched authors
receive a pending-trust comment; a maintainer can rerun after vouching.

The controller resolves current `main` and the PR head to full SHAs, builds both in separate Prime
sandboxes, and alternates their measurements. Both use the same trusted harness revision, image
digest and resource allocation. No performance gate blocks merging.
The baseline is always current `main`, not the PR's target branch or merge base.

## Enable in GitHub

Add the repository secret `PRIME_SANDBOX_API_KEY`: a dedicated key with Sandbox permissions for
provisioning and cleanup. Optional `PRIME_BENCHMARK_TEAM_ID` selects the sandbox billing workspace.
No inference key, model configuration, or login is required.

The workflows must first land on `main`: both `pull_request_target` and the completion listener run
trusted default-branch code. Trigger `Prime Agent benchmarks` manually with an open PR number after
configuring the sandbox secret. The first rollout should include a main-versus-main calibration.

The request checks out the event's `GITHUB_SHA`, which GitHub resolves to the default-branch commit for
[`pull_request_target`](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/),
including stacked PRs. The benchmark job uses that exact harness SHA. Manual dispatch is allowed only
from `main`.

No credentials are injected into the sandboxes. The sandbox control key and GitHub token stay on the
trusted controller; a separate publisher owns GitHub comment write permission. No PR checkout,
build script, installer, executable, or archive is executed/extracted on a privileged GitHub runner.
The existing Vouch gate controls who can trigger compute usage.

## Measurements

The default configuration uses two Linux x64 containers, each with 4 vCPU, 8 GB RAM, and 20 GB disk.
`config.json` pins the image and sampling policy. Harness dependencies are locked with a seven-day
release cutoff. Provisioning, harness setup, and source compilation have separate recorded durations
outside the timed installation interval. Interactive runs use the same small committed Git fixture.

The base image supplies Node, npm, Git, curl, and Python. Untimed sandbox setup adds Python venv
support, Cairo/Pango/JPEG/GIF/SVG development libraries, ripgrep, and fd. These prerequisites are
shared within each sandbox; the normal installer still prepares each user's stock Python environment
and other missing tools. Their setup time and disk usage are outside the installation metrics.

- **Cold startup:** process launch until the editor visibly echoes a typed marker, after stopping all
  processes owned by the benchmark user. OS filesystem caches are not flushed.
- **Warm startup:** the same input-ready measurement while retaining the daemon and stopping its
  previous active sessions. Each TUI launch opens a fresh conversation.
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

Startup and memory use 10 trials per revision. Installation uses three; sizes are measured once. UI interactions use 3 trials per revision (`ui_trials`).
Stock tools, skills, daemon, persistence, and Python bootstrap remain enabled. Homes contain no
credentials, extensions, MCP servers, or personal skills. The onboarding splash is marked as already
shown before timing, so startup measures the editor rather than waiting for a person to sign in.
The editor runs without a selected model; no prompts are submitted. These measurements cover the
local startup path, not authenticated provider discovery or inference.

### Python runtime

A separate probe drives the **installed** `python -m rlm.repl` over its JSONL protocol. It measures the
CPython kernel and stock `rlm.bash` implementation, including IPC, serialization, and output capture.
It does not include the TypeScript kernel manager, TUI rendering, or model execution. The harness
fails visibly if either revision does not support the required runtime protocol; it never substitutes
a plain Python process or omits a failed metric.

Each of the 10 trials starts with all benchmark-user processes stopped and a new kernel:

- **Kernel startup:** process spawn through the protocol-ready handshake. Includes the small
  `runuser` launch overhead; excludes Python installation and host-side agent bootstrap.
- **Python cell round trip:** mean of 50 sequential `pass` cells through the complete request/done
  protocol. Five Python cells and one empty bash command warm the runtime before execution timings.
- **Empty bash command:** mean of five `await bash(':')` calls with successful, empty results.
- **Bash git status:** mean of five `git status --porcelain` calls in the fixed, clean Git fixture.
- **Bash 32 KiB output:** mean of five shell commands producing exactly 32,768 bytes. The runtime
  captures and forwards the entire output, and the probe verifies its byte count.
- **35 cells / 9 shell calls:** total time for a fixed mix of 26 Python no-ops and nine git-status
  calls, alternating one shell call with three Python cells.
- **Interrupt to done:** after an executing cell signals readiness, send an interrupt and wait for
  its KeyboardInterrupt/done acknowledgement. A subsequent cell must still execute successfully.
- **State snapshot:** serialize a 10,000-row, eight-column integer pandas DataFrame and a
  10,000-integer list to disk. Includes first-use serialization imports.
- **State restore:** restore that state into a fresh kernel, including first-use pandas imports but
  excluding kernel startup. Verify the recovered dimensions, sum, and list values after timing.
- **Kernel idle RSS:** memory immediately after the ready handshake, before workload imports.
- **Kernel RSS after pandas workload:** memory after the mixed calls and construction of the same
  DataFrame/list used for snapshotting. Both memory measurements include only the isolated user's
  Python process; raw per-process measurements are retained.

The runtime rows show medians across the 10 independent trials. Batch iteration counts and fixture
sizes are fixed in `kernel.py`; failures and incomplete output remain failed samples. These are
subsystem measurements alongside the normal installed CLI benchmarks, not end-to-end tool latency.

The comment has four columns: metric, main, PR, and signed change with the percentage in parentheses.
A single summary counts regressions, improvements, metrics with no clear change, and incomplete or
unavailable comparisons. Improvements are green with `↓`, regressions red with `↑`, and changes within
the noise threshold remain neutral with `≈`. The entire change value, including the arrow, delta, and
percentage, goes from muted to vivid as the absolute percentage grows, reaching maximum intensity at
100%. An undefined percentage uses the muted shade. Colors use GitHub's native MathJax rendering;
no external badge service is required. Successful/attempted counts and spread appear in the collapsed
methodology.
Arrows require a change larger than the metric's absolute floor, relative floor,
and observed spread. The initial relative floor is 20% for timings and memory, 0.5% for artifact
size, and 1% for disk footprint. A same-revision calibration on separate sandboxes showed roughly
7–18% variation across several timings; the conservative floor avoids labeling that as a code regression.
Smaller signed differences remain visible. Revisit these floors after collecting more control runs. This is a practical noise filter, not a statistical significance test. Inspect
raw trials before acting on small changes; sandbox scheduling and filesystem caches still introduce noise.

### UI interactions

A separate probe drives the interactive TUI over a PTY with the same `pexpect`/`pyte` harness the
startup metrics use, against a deterministic on-disk fixture set. Every UI trial regenerates the
sessions directory, session artifacts, and spawn ledger from scratch, so trials cannot inherit state.

The fixture set is fixed and mirrors a long-lived install: 194 top-level sessions (3 large —
one of them a very large ~40 MB transcript — 150 medium, 40 small fan-out children of the chain
root, and the root itself) plus a chain of 6 nested subagent sessions. Large sessions hold 2,000
user/assistant/toolResult triples (~5 MB of JSONL each), the very large one 16,000 (~40 MB),
medium sessions 120, and each subagent 400. Content is synthetic but shaped like real transcripts
(thinking, tool calls, tool output). The subagent chain and the fan-out are linked through the
same spawn-ledger records the daemon replays (~46 edges), so roster hydration, catalog scanning,
and saved-session paths are exercised at a scale where regressions are visible. No inference is
called at any point.

Each trial stops all benchmark-user processes first, then measures:

- **Resume large session (cold):** `prime-agent --resume <id>` from process spawn until the resumed
  transcript tail is rendered and the editor echoes a typed marker. This is the "switch into a large
  session" path including daemon and session-worker startup.
- **Switch into large session:** in a running TUI, `/resume <id>` keystroke to rendered tail plus
  echoed marker. Measures the in-place session switch with a ~40 MB transcript.
- **Open agents view from a session:** the left-arrow keystroke to the rendered agents-view splash.
- **Full agents roster, many sessions:** from the same keystroke until the roster's saved-session
  count stops growing. Saved sessions stream in, so this isolates catalog scanning, spawn-ledger
  replay, and hydration across 200 session files.
- **Open another session from agents view:** typing the target's unique session-id prefix,
  right-arrow to open, until the target transcript renders and echoes. This is the full
  "session → agents view → another session" round trip with many sessions on disk.
- **Open chain parent from agents view:** back to the agents view, search the subagent chain's
  root session by id prefix, right-arrow to open. The parent becomes live.
- **Open subagent session at depth 6:** back to the agents view, then drill into the live chain:
  filter by the deepest subagent's id prefix, clear the search (expansion needs an empty query),
  expand the parent, refilter past the fan-out siblings, and repeat clear-expand-step for each of
  the six levels until the deepest subagent row is selected, then right-arrow to open. This is the
  exact manual flow the product requires today, so the metric includes its real cost.
- **CPU per interaction:** summed `utime+stime` across the whole benchmark-user process tree
  (TUI client, daemon, session workers, Python kernels) between two instants around each interaction.
- **UI memory after interactions:** summed RSS across the same tree after the scenario settles.
  Per-process snapshots with PSS and CPU are saved as raw artifacts, as for idle memory.

Readiness is never a spinner or a status line: a trial only counts when the target session's
final transcript line is visible and the editor echoes a marker, so half-rendered states fail
loudly instead of measuring fast. Raw results also record PTY bytes per interaction, a proxy for
how much the renderer redraws. UI trials default to 3 per revision (`ui_trials` in `config.json`)
to bound sandbox cost; the scenario takes roughly 60–90 s per trial.

## Lifecycle and costs

The main workflow posts a single marked comment and updates it in place. A new push replaces the
previous table with a short running notice and a link to the latest run. The completion workflow
fills that same comment with the latest results or a cancellation/failure notice. Previous results
remain available in workflow artifacts. Publishers serialize by PR and check the
current head, latest run ID, attempt, and existing comment generation before writing. A rerun of an
older commit cannot overwrite a newer result, including when the newer run has the same head SHA.

Results and logs are retained as GitHub artifacts for 14 days. They include exact source and harness
SHAs, environment details, installed dependency inventory, transcripts, raw observations, failures,
and estimated sandbox costs. The publisher validates schema, identity, finite numbers, and report
size and escapes sandbox-provided text.

The controller stops scheduling work at 25 minutes or its $1 estimated budget target. Every sandbox
has a 30-minute TTL. Teardown runs in `finally`; the independent completion workflow deletes any
remaining sandboxes with the exact repository/run/attempt labels, including after cancellation.
Cleanup enumerates all pages before deleting so pagination cannot skip a sandbox.

At the configured list rates, two sandboxes cost about $0.01/minute together. A 10-minute run costs
about $0.10 in sandbox compute. There are no inference charges. UI-interaction trials add roughly
3–6 minutes per run at the default 3 trials per revision. Full sandbox lifetimes are recorded,
including provisioning, setup, building, measurements, and cleanup. The $1 target is an estimate,
not a hard billing cap; scheduling and deletion latency can increase the final bill.

## Local development

The existing runtime Python CI job runs the harness checks. To run them locally from this directory:

```sh
uv sync --locked
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked python -m unittest discover -s tests -v
```

Tests use fake GitHub/SDK responses and terminal streams; they never invoke inference or provision
sandboxes. A live run is separate and requires only the `PRIME_SANDBOX_API_KEY` environment variable:

```sh
uv run --locked cli.py local --base FULL_MAIN_SHA --head FULL_HEAD_SHA --results results/local
```

Use identical SHAs to calibrate main against itself. `--config /path/to/config.json` can reduce trials
for a smoke run; the report records the effective configuration. Local mode never posts GitHub
comments. `results/`, `.venv/`, and `.ruff_cache/` are ignored. Run the repository's `npm run check`
after code changes as well.
