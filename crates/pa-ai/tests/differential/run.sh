#!/usr/bin/env bash
# Prime-inference differential verifier.
#
# 1. Replays the captured real SSE exchange with z-ai/glm-5.3-flash through a
#    local server.
# 2. Runs the TS reference provider (scratch copy of the TS repo with
#    node_modules) and the Rust port against the same bytes.
# 3. Fails if assistant text, usage accounting, or stop reasons differ.
#
# Usage: tests/differential/run.sh [ts-repo-scratch-dir]
#   ts-repo-scratch-dir defaults to /tmp/pa-ts (a writable copy of the TS repo
#   with node_modules installed).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CRATE_DIR="$HERE/../.."
TS_SCRATCH="${1:-/tmp/pa-ts}"
PORT="${PA_DIFF_PORT:-18097}"

if [ ! -d "$TS_SCRATCH/node_modules" ]; then
  echo "TS scratch dir $TS_SCRATCH has no node_modules; pass a runnable TS copy" >&2
  exit 1
fi

# Start the replay server.
python3 "$HERE/replay_server.py" "$PORT" &
REPLAY_PID=$!
trap 'kill $REPLAY_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/" --max-time 1; then break; fi
  sleep 0.1
done

REPLAY_URL="http://127.0.0.1:$PORT/api/v1"

# TS baseline: copy the driver into the scratch repo so module resolution works.
cp "$HERE/ts_driver.ts" "$TS_SCRATCH/ts_driver.ts"
(cd "$TS_SCRATCH" && npx tsx ts_driver.ts "$REPLAY_URL") > /tmp/pa_diff_ts.json
echo "--- TS baseline written ---"

# Rust side.
PA_DIFF_REPLAY_URL="$REPLAY_URL" PA_DIFF_EXPECTED=/tmp/pa_diff_ts.json \
  cargo test -p pa-ai --lib differential_prime_inference -- --ignored --nocapture

echo "DIFFERENTIAL PASS: Rust matches the TS reference for z-ai/glm-5.3-flash"
