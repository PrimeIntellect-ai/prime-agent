#!/usr/bin/env bash
# CI entry for the perf wave (driven by ci/workflows/benchmark.yml).
#
# Creates an ephemeral Prime sandbox (4 CPU / 16 GB, the same spec class the
# baseline was recorded on), installs the deployed TS binary plus a fresh
# release build of the checkout, runs scripts/battery/run_perf_wave.sh
# there, downloads the results, gates them against the recorded baseline,
# and terminates the sandbox. Every timing comes from the same quiet
# machine for both sides, which is the whole point of the sandbox.
#
# Requirements on the runner: the `prime` CLI, docker-image access to
# rust:1, tmux/python3 inside the sandbox image, network access.
#
# Environment:
#   PA_BENCH_NO_SANDBOX=1   run the wave directly on this runner instead
#   PRIME_SANDBOX_NAME      sandbox name (default build-perf-benchmark)
#   PRIME_BENCH_TRIALS      trial count (default 5)
set -euo pipefail
cd "$(dirname "$0")/../.."

SANDBOX_NAME="${PRIME_SANDBOX_NAME:-build-perf-benchmark}"
TRIALS="${PRIME_BENCH_TRIALS:-5}"

if [ -n "${PA_BENCH_NO_SANDBOX:-}" ]; then
    PRIME_BENCH_TRIALS="$TRIALS" scripts/battery/run_perf_wave.sh
    exit $?
fi

SANDBOX_ID="$(
    PRIME_DISABLE_VERSION_CHECK=1 prime sandbox --plain create \
        --name "$SANDBOX_NAME" rust:1 \
        --cpu-cores 4 --memory-gb 16 --disk-size-gb 80 \
        --timeout-minutes 300 -y |
        grep -oE '[0-9a-z]{20,}' | tail -1
)"
cleanup() {
    PRIME_DISABLE_VERSION_CHECK=1 prime sandbox --plain delete "$SANDBOX_ID" >/dev/null 2>&1 || true
}
trap cleanup EXIT
echo "== sandbox $SANDBOX_ID"

run_in_sandbox() {
    # 300s exec cap: long work runs detached with a DONE-marker poll.
    PRIME_DISABLE_VERSION_CHECK=1 prime sandbox --plain run "$SANDBOX_ID" "$1"
}

# 1. ship the checkout + the deployed TS release into the sandbox.
git bundle create /tmp/benchmark.bundle --all
prime sandbox --plain upload "$SANDBOX_ID" /tmp/benchmark.bundle /tmp/benchmark.bundle
RELEASE_TREE="$(dirname "$(readlink -f "$(command -v prime-agent)")")/.."
# shellcheck disable=SC2012
TS_RELEASE_TAR=/tmp/ts-release.tar
tar cf "$TS_RELEASE_TAR" -C "$RELEASE_TREE" .
prime sandbox --plain upload "$SANDBOX_ID" "$TS_RELEASE_TAR" /tmp/ts-release.tar

cat > /tmp/sb-benchmark.sh <<'EOF'
#!/bin/bash
set -euo pipefail
mkdir -p /opt/repo /opt/ts-release
cd /opt/repo
git clone /tmp/benchmark.bundle repo
cd repo
git checkout "${GITHUB_HEAD_REF:-main}"
git log --oneline -1
tar xf /tmp/ts-release.tar -C /opt/ts-release
TS_BIN=$(find /opt/ts-release -maxdepth 3 -name prime-agent -type f | head -1)
ln -sf "$TS_BIN" /usr/local/bin/prime-agent
prime-agent --version | head -1
apt-get update -qq && apt-get install -y -qq tmux procps time
# 2. fresh release build + the wave, detached (the 300s exec cap).
nohup bash -c '
    cd /opt/repo/repo &&
    PRIME_BENCH_TRIALS="'"$PRIME_BENCH_TRIALS"'" \
    PA_WAVE_RUST_BIN=/opt/repo/repo/target/release/prime-agent \
    scripts/battery/run_perf_wave.sh
    echo $? > /opt/wave.exit
' > /opt/wave.log 2>&1 &
echo detached-started
EOF
prime sandbox --plain upload "$SANDBOX_ID" /tmp/sb-benchmark.sh /tmp/sb-benchmark.sh

# 3. poll the detached wave to completion.
DEADLINE=$(( $(date +%s) + 14400 ))
while true; do
    STATUS=$(run_in_sandbox "if [ -f /opt/wave.exit ]; then cat /opt/wave.exit; else echo running; fi" | tail -1 | tr -d '[:space:]')
    [ "$STATUS" != "running" ] && break
    if [ "$(date +%s)" -gt "$DEADLINE" ]; then
        echo "FATAL: sandbox wave exceeded the 4h poll deadline" >&2
        exit 2
    fi
    sleep 60
done
run_in_sandbox "tail -n 40 /opt/wave.log" || true
if [ "$STATUS" != "0" ]; then
    echo "FATAL: sandbox wave exited with $STATUS (log above)" >&2
    exit 2
fi

# 4. pull the results back and gate them on the runner.
mkdir -p scripts/battery/runs
RUN_DIR="scripts/battery/runs/perf-wave-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN_DIR"
RUN_IN_SANDBOX_DIR=$(run_in_sandbox "ls -1dt /opt/repo/repo/scripts/battery/runs/perf-wave-* | head -1" | grep perf-wave | head -1)
prime sandbox --plain download "$SANDBOX_ID" "$RUN_IN_SANDBOX_DIR/results.json" "$RUN_DIR/results.json"
python3 scripts/battery/perf_gate.py --results "$RUN_DIR/results.json"
echo "== wave results: $RUN_DIR"
