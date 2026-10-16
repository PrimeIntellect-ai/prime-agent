# Offline performance tooling and hosted build export

The existing CI's `performance-artifacts` job builds exact PR base/head commits on
separate disposable GitHub-hosted runners. It preserves contributor/draft gates,
uses read-only contents permission, disables persisted checkout credentials and
uses no shared candidate cache. Rust 1.98.1 and the Ubuntu 22.04 image match the
continuous release build. It performs no benchmarks, node transport or publishing.
Merging the workflow change enables this additional build cost; it does not enable
a benchmark controller or report-writing job.
Ordinary CI skips drafts and can cancel superseded PR runs, including export jobs;
this job alone does not guarantee an artifact for every intermediate commit.

Each run-attempt/side/SHA artifact contains the existing release assembler's Linux
x64 source bundle and split-debug decoder, a stripped release-profile pa-core
library test executable, ten prebuilt runtime/skill wheels, checksums and `receipt.json`. Both executables are gated
at GLIBC <=2.35 using objdump/readelf, without running them. The library test payload
does not include workspace integration tests or their fixtures; tests that refer
to compile-time source paths need separate fixture support. Catalogs are synthetic
offline fixtures. Exported files are capped at 512 MiB each and 1 GiB total before
the small receipt is added; compressed size limits do not bound extraction size.
The release bundle contains Python runtime/skill source, while `runtime-wheels.tar.gz`
contains matching pure Python wheels built only on the disposable hosted builder.
The builder uses Python 3.12.13 and hash-pinned Hatchling dependencies from
`wheel-build.lock`. Node preparation installs wheels offline into fresh environments,
checks dependencies and imports all ten packages before timing. Candidate build hooks
never run on the persistent measurement node; candidate imports remain confined.

The exporter uses tooling checked out at the workflow's recorded SHA, which is
PR-influenced merge workflow code on a pull_request run. An artifact
consumer must allow only reviewed builder revisions and independently bind repository,
workflow/run/attempt, source/base/head SHA and payload hashes to GitHub metadata.
A PR can alter its workflow/build code; a receipt is provenance data, not attestation
that candidate code measured honestly. Validate bounded regular-file archives before
extraction; do not execute artifacts on the controller or give measurement code
reporting credentials. The current manual node launcher accepts a hardcoded release;
a reviewed manifest/input interface is still required for arbitrary candidate artifacts.

For manual offline measurements, prepare two environments from the matching runtime
wheels using the reviewed hash lock. Install PTY tooling from `bootstrap.lock` and
`requirements.lock` using Python 3.12.13 before timing. Run inside a fresh, networkless,
resource-bounded environment; the harness itself does not provide confinement:

Before running `run.py`, pass the downloaded, safely unpacked artifact directories to
`inputs.py` with the independently verified full base/head/event-head/builder SHAs,
source repository, PR, workflow reference, run and attempt; the target repository is
fixed to `PrimeIntellect-ai/prime-agent`. This validates bounded regular-file
payloads and executable hashes, then unpacks both the release and `runtime-wheels.tar.gz`
into `--out/base` and `--out/head`. `run.py --inputs` consumes that prepared directory;
it must not be pointed at the raw upload-artifact download. Directory permissions are
normalized for the confined read-only user even when the operator uses umask077.
The preparer executes no candidate code and makes no network calls.

```sh
python scripts/performance/session_bench.py --base-bin /base/prime-agent --head-bin /head/prime-agent --base-runtime /base/venv/bin/python --head-runtime /head/venv/bin/python --base-sha FULL_BASE_SHA --head-sha FULL_HEAD_SHA --out comparison
python scripts/performance/kernel_bench.py --base-runtime /base/venv/bin/python --head-runtime /head/venv/bin/python --base-sha FULL_BASE_SHA --head-sha FULL_HEAD_SHA --out kernel-comparison
```

Session workloads cover fresh daemon/client first paint, persisted-history tail and
ten-character editor acknowledgment, warm open/reopen, a 150-session catalog, large
histories and a concurrent session. Warm navigation deliberately includes a one-second
idle workload cadence; it is not a readiness assertion. Kernel probes cover real
protocol startup, cells, shell/git/output/file I/O, interrupt recovery and state restore.
Neither suite calls a model provider. RSS is an immediate process-tree sample, not PSS
or settled memory. Retain the runtime inventories: interpreter hashes, installed package
files, shared dependency files and dependency-lock identity accompany each comparison.

Defaults are ten alternating pairs. Calibrate the identical baseline as A/A before
interpreting deltas; retain failures and label rows inconclusive when median drift or
MAD exceeds 10%. Ten-sample p95 is descriptive, not a precise tail guarantee. Existing
pilot evidence showed reopening variance associated with probe retries; do not discard
slow retries to make a gate pass. Cold means a fresh process lifecycle, not cold hardware
caches. Record actual confinement limits and complete runtime identity with each run.

Trace-upload follow-up requires matched artifacts, consent on/off, bounded synthetic
outboxes, and an isolated loopback stub via `PRIME_AGENT_TRACES_BASE_URL`; no real traces,
credentials or external uploads. Marker timing must preserve the implementation's
synchronous no-fsync boundary and include consent metadata checks. This workload is
not implemented by the artifact exporter.

Controller queuing/every-intermediate-commit dispatch, node admission/cleanup recovery,
authenticated result transport and trusted GitHub status/comment publishing are separate
changes. No persistent credentials or reporting-write permissions are added here.
