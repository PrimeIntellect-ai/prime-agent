#!/usr/bin/env bash
# Local runner for the perf wave: run it exactly the way the CI workflow
# does (see .github/workflows/benchmark.yml), on this machine.
#
#   scripts/battery/run_perf_wave.sh [extra perf_wave.py args]
#
# Environment:
#   PA_WAVE_SKIP_BUILD=1     do not rebuild the rust release binary
#   PA_WAVE_TRIALS=N        trial count (default 5)
#   PA_WAVE_DIMS=...        comma list (default all)
#   PA_WAVE_RUST_BIN=...    rust binary (default target/release/prime-agent)
#   PA_WAVE_TS_BIN=...      ts binary (default prime-agent on PATH)
#
# Timings are only comparable when both sides run on the same quiet machine:
# the intended host for this script is a fresh Prime sandbox (the CI entry
# scripts/battery/ci_perf_wave.sh drives exactly that), but it also runs
# locally for smoke checks.
set -euo pipefail
cd "$(dirname "$0")/../.."

TRIALS="${PA_WAVE_TRIALS:-5}"
DIMS="${PA_WAVE_DIMS:-all}"
RUST_BIN="${PA_WAVE_RUST_BIN:-target/release/prime-agent}"
TS_BIN="${PA_WAVE_TS_BIN:-prime-agent}"

if [ -z "${PA_WAVE_SKIP_BUILD:-}" ]; then
    echo "== building rust release binary" >&2
    cargo build --release -p pa-cli
fi

if [ "$DIMS" = "all" ]; then
    DIMS_ARG=""
else
    DIMS_ARG="--dims $DIMS"
fi

echo "== running the perf wave (trials=$TRIALS)" >&2
python3 scripts/battery/perf_wave.py \
    --trials "$TRIALS" $DIMS_ARG \
    --ts-bin "$TS_BIN" --rust-bin "$RUST_BIN" \
    "$@"

RUN_DIR=$(ls -1dt scripts/battery/runs/perf-wave-* | head -1)
echo "== gating against scripts/battery/perf-baseline.json" >&2
python3 scripts/battery/perf_gate.py --results "$RUN_DIR/results.json"
echo "== results: $RUN_DIR"
