#!/usr/bin/env bash
# Bounded autonomous burst launcher for Prime Agent (POSIX / Git Bash).
#
# Usage: harness/burst.sh <profile> "<prompt>" [extra prime-agent args...]
# Profiles (turns / tokens / wall-time / continuations / gate):
#   repair      8 /  40k / 20m / 3 / quick gate (10m gate budget)
#   feature    24 / 180k / 3h  / 6 / changed-files gate (90m gate budget)
#   formal     20 / 160k / 3h  / 5 / changed-files gate (90m gate budget)
#   simulate   20 / 140k / 4h  / 5 / changed-files gate (90m gate budget)
#
# Gate timeouts dominate the manifest: each profile's gate budget exceeds the
# sum of its manifest per-check timeouts (see manifest _readme invariant).
#
# The gate DEFINITION (verify.py + manifest.json + manifest_policy.py) is frozen to a temp copy at
# launch: mid-burst edits to harness/ cannot change what the gate checks.
# Review any pre-burst edits to harness/ before launching.
#
# All values are passed as SEPARATE arguments (Prime Agent does not parse
# --flag=value). Exit code: 0 = gate passed; 1 = gate failing or limit hit
# ("reaching a limit does not imply task success").
set -euo pipefail

PROFILE="${1:?usage: burst.sh <repair|feature|formal|simulate> \"<prompt>\"}"
PROMPT="${2:?missing prompt}"
shift 2

case "$PROFILE" in
  repair)   TURNS=8;  TOKENS=40000;  TIMEOUT_MS=1200000;  GATE_MS=600000;  CONT=3; GATE_PROFILE=quick ;;
  feature)  TURNS=24; TOKENS=180000; TIMEOUT_MS=10800000; GATE_MS=5400000; CONT=6; GATE_PROFILE=changed-files ;;
  formal)   TURNS=20; TOKENS=160000; TIMEOUT_MS=10800000; GATE_MS=5400000; CONT=5; GATE_PROFILE=changed-files ;;
  simulate) TURNS=20; TOKENS=140000; TIMEOUT_MS=14400000; GATE_MS=5400000; CONT=5; GATE_PROFILE=changed-files ;;
  *) echo "unknown profile: $PROFILE" >&2; exit 64 ;;
esac

if command -v prime-agent >/dev/null 2>&1; then BIN=prime-agent
elif command -v pi >/dev/null 2>&1; then BIN=pi
else echo "error: neither 'prime-agent' nor 'pi' on PATH" >&2; exit 127; fi

# Freeze the gate definition so ordinary workspace edits cannot change gate retries.
# This is not isolation from malicious same-account temp-directory tampering.
GATE_DIR="$(mktemp -d)"
trap 'rm -rf "$GATE_DIR"' EXIT
cp harness/verify.py harness/manifest.json harness/manifest_policy.py "$GATE_DIR/"
# cmd.exe runs the gate on native Windows: give it a Windows-style path
if command -v cygpath >/dev/null 2>&1; then
  GATE_DIR_SHELL="$(cygpath -m "$GATE_DIR")"
else
  GATE_DIR_SHELL="$GATE_DIR"
fi

echo "burst: profile=$PROFILE bin=$BIN turns=$TURNS tokens=$TOKENS timeout_ms=$TIMEOUT_MS gate=$GATE_PROFILE gate_ms=$GATE_MS" >&2

"$BIN" \
  --autonomous \
  --autonomous-gate "python \"$GATE_DIR_SHELL/verify.py\" --manifest \"$GATE_DIR_SHELL/manifest.json\" --profile $GATE_PROFILE" \
  --autonomous-gate-retries 3 \
  --autonomous-gate-timeout-ms "$GATE_MS" \
  --autonomous-max-continuations "$CONT" \
  --autonomous-max-turns "$TURNS" \
  --autonomous-max-tokens "$TOKENS" \
  --autonomous-timeout-ms "$TIMEOUT_MS" \
  "$@" \
  -p -- "$PROMPT"
