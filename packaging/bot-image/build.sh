#!/usr/bin/env bash
# build.sh - publish the bot image and bake its VM artifact.
#
# Runs prepare.sh, pushes the build context with the Prime CLI (the build
# is server-side; no local Docker), waits for the tag to report COMPLETED,
# then creates and deletes one short-lived sandbox. That first create is
# what converts the container image into a VM artifact, so the first real
# bot of a new tag starts at once instead of sitting in PENDING.
#
# Usage:
#   ./build.sh --version 0.10.3 [--tarball /path/to/prime-agent-0.10.3-linux-x64.tar.gz] [--tag latest]
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
version=
tarball=
tag=latest

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) [[ $# -ge 2 ]] || fail '--version needs a value'; version=$2; shift 2 ;;
    --tarball) [[ $# -ge 2 ]] || fail '--tarball needs a value'; tarball=$2; shift 2 ;;
    --tag) [[ $# -ge 2 ]] || fail '--tag needs a value'; tag=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[[ -n "$version" ]] || { usage >&2; fail '--version is required'; }
[[ "$tag" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || fail "invalid tag: $tag"
command -v prime >/dev/null 2>&1 || fail 'the prime CLI is not installed'

if [[ -n "$tarball" ]]; then
  "$here/prepare.sh" --version "$version" --tarball "$tarball"
else
  "$here/prepare.sh" --version "$version"
fi

image="prime-agent-bot:$tag"
ref="prime/primeintellect/$image"
say "Pushing $image (server-side build; this takes minutes)"
prime images push "$image" --context "$here" --dockerfile "$here/Dockerfile"

# The push can return before the build finishes; wait for a COMPLETED row
# for this exact tag (the newest one, since a re-push replaces the tag).
status_of() {
  prime images list --search "prime-agent-bot:$tag" --output json --num 250 2>/dev/null \
    | python3 -c '
import json, sys
tag = sys.argv[1]
rows = [r for r in json.load(sys.stdin).get("data", [])
        if r.get("imageName") == "prime-agent-bot" and r.get("imageTag") == tag]
rows.sort(key=lambda r: r.get("createdAt") or "", reverse=True)
print(rows[0]["status"] if rows else "MISSING")
' "$tag"
}
for _ in $(seq 1 120); do
  status=$(status_of)
  case "$status" in
    COMPLETED) break ;;
    FAILED|CANCELLED) fail "image build $status" ;;
  esac
  sleep 15
done
[[ "${status:-}" = COMPLETED ]] || fail "image build did not complete (last status: ${status:-unknown})"
say "Image ready: $ref"

say "Baking the VM artifact (one short-lived sandbox)"
create=$(prime sandbox create "$ref" --name "bot-image-bake-$tag" \
  --cpu-cores 2 --memory-gb 4 --disk-size-gb 20 --timeout-minutes 60 --yes --plain 2>&1) \
  || { printf '%s\n' "$create" >&2; fail 'bake sandbox create failed'; }
id=$(printf '%s\n' "$create" | sed -n 's/.*Successfully created sandbox \([a-z0-9]*\).*/\1/p' | head -1)
if [[ -n "$id" ]]; then
  # The bake also proves the image runs: the guest answers its version and
  # passes the relay probe under a plain system PATH. A freshly placed
  # sandbox refuses commands for a few seconds, so retry.
  # set -euo pipefail inside: the probe must fail when any check fails,
  # not just the last pipeline.
  probe='set -euo pipefail; export PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin; prime-agent --version; prime-agent relay --probe; node --version; gh --version | head -1'
  ok=0
  for _ in $(seq 1 20); do
    if prime sandbox run "$id" --plain -- bash -c "$probe"; then ok=1; break; fi
    sleep 6
  done
  if [[ "$ok" != 1 ]]; then
    prime sandbox delete "$id" --yes >/dev/null 2>&1 || true
    fail "the image did not answer its probe"
  fi
  prime sandbox delete "$id" --yes >/dev/null 2>&1 || true
  say "Baked $ref (sandbox $id deleted)"
else
  say "Sandbox created but its id was not read back; delete it by label if it lingers"
fi
say "Done. Bots default to $ref."
