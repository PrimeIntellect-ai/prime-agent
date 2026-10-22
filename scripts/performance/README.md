# Offline performance comparisons

Interactive performance has one owner: `crates/pa-perf`. Its existing
`.github/workflows/perf.yml` runs nightly and for PRs carrying `perf-test`.
It builds one driver/binary pair and uses product-typed deterministic corpora,
not handwritten session JSONL. `session_bench.py` only orchestrates alternating
base/head runs through that driver. It has no PTY implementation or fixture schema.

The additional per-PR release exporter is intentionally absent until a reviewed
artifact consumer exists. Do not rebuild main for each PR: use the existing
`continuous.yml` artifact `artifacts-x86_64-unknown-linux-gnu` for the exact base
commit, with its existing release manifest, binary checksum, image and GLIBC gate.
Candidate releases must come from an independently reviewed hosted build using
the existing release assembler. There are no pa-core library-test payloads or
parallel runtime-wheel artifacts.

## Prepare inputs without executing candidates

Before `inputs.py`, independently verify GitHub repository, exact commit,
workflow path and reviewed workflow revision, run, attempt and successful build
conclusion for each downloaded artifact. The release manifest records source
identity and checksums, not a trusted builder attestation. Never accept candidate
receipts or candidate workflow success as proof that performance was measured
honestly. Preserve the verified GitHub metadata with the results.

`inputs.py` validates the existing release manifests and bounded regular-file
archives, verifies the extracted executable hash and writes separate base/head
source bundles. It performs no network requests or candidate execution:

```sh
python3 scripts/performance/inputs.py \
  --base-artifact /downloads/base --head-artifact /downloads/head \
  --base-sha FULL_BASE_SHA --head-sha FULL_HEAD_SHA --out /inputs
```

Extraction is Linux-only. Absolute/traversing paths, links, special files,
duplicate normalized paths and expanded-size overflows are rejected. Files are
limited to 512 MiB each. The complete decompressed TAR stream, including
extension metadata, is limited to 1 GiB before parsing; parser read requests
cannot exceed the bounded stream. Compressed size alone is not a bound.

## Use the product's runtime

Prepare each side in a separate disposable workload environment by running its
**actual matching binary** with `--prime-agent-bootstrap` and `PI_PACKAGE_DIR`
pointing to its extracted release bundle. This prepares the base runtime and
default packages, not bundled Python skills. Start one normal session with that
binary and wait for kernel preparation to finish while still online, so the
product installs its discovered skills too. Then close the session. Keep its
isolated `HOME` and resulting `kernel-venv/bin/python`; pass that interpreter to
the comparison. The inventory requires every bundled Python skill to be installed
before measurement; missing skills mean preparation is incomplete. Product code
owns dependency resolution (`DEFAULT_RLM_EXTRA_PACKAGES` and the bundled runtime
metadata/lock). This harness neither installs a copied dependency list nor adds
a `.pth` link to its own environment. Bootstrap/package installation is untimed
and may need network access in that disposable preparation environment. Freeze
and inventory the prepared environment, then disable network before measurement.
Keep each extracted release at the same absolute path during bootstrap and
measurement: editable bundled skills embed that path. Both suites require the
matching `--base-package` and `--head-package` paths for source identity capture.
Never bootstrap candidates or execute candidate build hooks on a controller or
persistent measurement node. No runtime install happens on the local laptop.

Use the same independently reviewed `pa-perf` driver for both release binaries:

```sh
python3 scripts/performance/run.py --out /output \
  --driver /reviewed/pa-perf \
  --base-bin /inputs/base/prime-agent --head-bin /inputs/head/prime-agent \
  --base-package /inputs/base --head-package /inputs/head \
  --base-runtime /base-home/.prime/agent/kernel-venv/bin/python \
  --head-runtime /head-home/.prime/agent/kernel-venv/bin/python \
  --base-sha FULL_BASE_SHA --head-sha FULL_HEAD_SHA --trials 10
```

Run inside fresh networkless, resource-bounded confinement; the harness itself
provides neither confinement nor transport. Give candidates no credentials or
report-writing permissions. Inventories record the actual interpreter and
installed package files and editable bundled-skill sources. Keep them with the
source, driver and harness hashes.

pa-perf covers cold/warm paint and attach readiness, agents view and warm scan,
large-history open, session switching, completion, ten-character editor echo and
opening a large history while another TUI holds a session, on product corpora. RSS snapshots are immediate process-tree RSS, not PSS or settled
memory. Kernel probes retain real protocol startup, cells, shell/git/output/file
I/O, interrupt recovery and snapshot/restore checks; they never call a model.
`--suite kernel` runs only that probe; `--suite session` runs pa-perf comparisons.
Every run retains raw samples, transcripts and failures. Cold means a fresh
process lifecycle, not cold hardware caches.

## Calibration and verification

Defaults are ten alternating pairs, plus an identical-baseline A/A run. Summary
rows contain median, median absolute deviation (MAD), relative MAD and the A/B
median delta. A row is `inconclusive` if it has fewer than five samples, zero
baseline, A/A median drift over 10%, or relative MAD over 10% on any side.
The 10% policy is a descriptive noise screen, not a calibrated product regression
threshold; `measured` never means a performance pass. No slow samples are dropped.
pa-perf retains its per-scenario p95 in the raw results; ten-sample p95 is not a
precise tail guarantee. Its existing baseline regression gate is unchanged.

Surviving Python test modules run in existing ordinary CI, and the real kernel
probe uses the existing test shard's product-bootstrapped interpreter. pa-perf's
Rust tests remain in the workspace gates. Do not run builds or tests on the laptop.

Controller queuing, every-intermediate-commit dispatch, measurement-node access,
cleanup recovery, result transport, trusted GitHub publication and trace-upload
workloads remain separate, unimplemented changes. This PR adds no persistent
credentials, reporting-write permissions or paid compute access.
