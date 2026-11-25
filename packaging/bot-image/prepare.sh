#!/usr/bin/env bash
# prepare.sh - stage the bot image build context.
#
# Copies (or downloads) one prime-agent linux-x64 release tarball into this
# directory as `prime-agent.tar.gz`, verifies it, and records its version.
# `make bot-image` runs this before `prime images push`.
#
# Usage:
#   ./prepare.sh --version 0.10.3 --tarball /path/prime-agent-0.10.3-linux-x64.tar.gz
#   ./prepare.sh --version 0.10.3                 # download the GitHub release
#   ./prepare.sh --version 0.10.3 --tarball ... --sha256 <tarball sha256>
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
version=
tarball=
sha256=

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) [[ $# -ge 2 ]] || fail '--version needs a value'; version=$2; shift 2 ;;
    --tarball) [[ $# -ge 2 ]] || fail '--tarball needs a value'; tarball=$2; shift 2 ;;
    --sha256)  [[ $# -ge 2 ]] || fail '--sha256 needs a value'; sha256=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[[ -n "$version" ]] || { usage >&2; fail '--version is required'; }
[[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || fail "invalid version: $version"

name="prime-agent-$version-linux-x64.tar.gz"
work=$(mktemp -d "${TMPDIR:-/tmp}/bot-image.XXXXXX")
trap 'rm -rf "$work"' EXIT

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else sha256sum "$1" | awk '{print $1}'; fi
}

if [[ -n "$tarball" ]]; then
  [[ -f "$tarball" ]] || fail "tarball not found: $tarball"
  cp "$tarball" "$work/$name"
  if [[ -z "$sha256" ]]; then
    printf 'Warning: no --sha256 given; trusting the local tarball\n' >&2
  fi
else
  base="https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v$version"
  curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" \
    || fail "no published release for $version (pass --tarball instead)"
  curl -fsSL --retry 3 -o "$work/$name" "$base/$name" || fail "download failed: $name"
  sha256=$(awk -v f="$name" '$2 == f || $2 == "*" f { print $1 }' "$work/SHA256SUMS")
  [[ -n "$sha256" ]] || fail "SHA256SUMS has no row for $name"
fi

actual=$(sha256_file "$work/$name")
if [[ -n "$sha256" && "$actual" != "$sha256" ]]; then
  fail "tarball sha256 $actual does not match $sha256"
fi

# The archive must be the shape the guest installer reads.
tar -tzf "$work/$name" | grep -qx 'install.sh' || fail "$name has no install.sh"
tar -xzf "$work/$name" -C "$work" package.json
packed=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$work/package.json")
[[ "$packed" = "$version" ]] || fail "tarball version $packed is not $version"

mv "$work/$name" "$here/prime-agent.tar.gz"
printf '%s\n' "$version" > "$here/version"
printf 'Prepared %s (%s bytes, sha256 %s)\n' "$name" "$(wc -c <"$here/prime-agent.tar.gz" | tr -d ' ')" "$actual"
printf 'Build context: %s\n' "$here"
