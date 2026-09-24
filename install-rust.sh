#!/bin/sh
# install-rust.sh — one-command installer for the Rust build of Prime Agent.
#
# What it installs: one rust-v* release's payload (the prime-agent binary,
# prime-agent-runtime/ kernel sidecar, skills/, docs/, LICENSE, README.md,
# and the commit-stamped package.json) under
# $PRIME_AGENT_RUST_PREFIX/share/prime-agent-rust/, plus a
# prime-agent-rust launcher in $PRIME_AGENT_RUST_PREFIX/bin/.
#
# It never writes any path the TypeScript product owns: no ~/.local/bin/prime-agent,
# no ~/.local/share/prime-agent/ — every path it creates carries the
# prime-agent-rust name, so a TS install on the same machine is untouched
# and the two products run side by side.
#
# Both products share the session store BY DESIGN (both read and write
# ~/.prime/agent — the sessions dir and its session leases — so the same
# sessions appear in either), but they never share a daemon: the launcher
# pins a rust-only daemon socket so this CLI can never attach to, shut
# down, or replace the TypeScript daemon (the products' daemon schema ids
# differ — over a shared socket, each side treats the other as a stale
# daemon to stop when idle; see docs/RUST_QUICKSTART.md).
#
# Config (env with defaults):
#   PRIME_AGENT_RUST_REPO    the <org>/<repo> to install from
#                            (default: PrimeIntellect-ai/prime-agent)
#   PRIME_AGENT_RUST_TAG     the rust-v* release tag to install
#                            (default: "latest" — the highest rust-v* release,
#                            stable preferred)
#   PRIME_AGENT_RUST_PREFIX  install prefix (default: ~/.local)
#
# The repo is private, so authentication is mandatory: `gh` is used when on
# PATH; otherwise GITHUB_TOKEN must be set and the REST API is called with
# curl (python3 parses the JSON — POSIX sh has no JSON parser, and the
# product itself needs a Python runtime for its kernel sidecar, so the
# dependency adds nothing the product does not already require).
set -eu

REPO="${PRIME_AGENT_RUST_REPO:-PrimeIntellect-ai/prime-agent}"
TAG="${PRIME_AGENT_RUST_TAG:-latest}"
PREFIX="${PRIME_AGENT_RUST_PREFIX:-$HOME/.local}"

die() { echo "install-rust.sh: $1" >&2; exit 1; }

# --- platform detection ----------------------------------------------------
# uname -m maps directly to the published target: an Apple-Silicon Mac whose
# shell (and therefore binaries) run under Rosetta 2 reports x86_64 and gets
# the x86_64 build, which is the correct build for that runtime.
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS:$ARCH" in
  Darwin:arm64) TARGET=aarch64-apple-darwin ;;
  Darwin:x86_64) TARGET=x86_64-apple-darwin ;;
  Linux:x86_64) TARGET=x86_64-unknown-linux-gnu ;;
  Linux:aarch64)
    die "no linux-arm64 rust build is published yet (uname reported ${OS} ${ARCH});
the rust-release pipeline publishes aarch64-apple-darwin, x86_64-apple-darwin,
and x86_64-unknown-linux-gnu today; track it for the aarch64-unknown-linux-gnu row"
    ;;
  *)
    die "no rust build is published for ${OS} ${ARCH} (detected via uname);
published targets: aarch64-apple-darwin, x86_64-apple-darwin, x86_64-unknown-linux-gnu"
    ;;
esac

# --- auth (the repo is private: no anonymous path exists) -------------------
if command -v gh >/dev/null 2>&1; then
  HAVE_GH=1
else
  HAVE_GH=0
  [ -n "${GITHUB_TOKEN:-}" ] \
    || die "the repo is private; authenticate with gh or set GITHUB_TOKEN"
fi

# --- resolve the release tag ------------------------------------------------
# The default resolves the highest rust-v* release, stable preferred — the
# same rule GitHub itself applies to "latest" (a prerelease loses to any
# stable release regardless of version, and only counts when no stable
# rust-v* release exists). Both resolution paths implement that one rule.
if [ "$HAVE_GH" = 1 ]; then
  if [ "$TAG" = "latest" ]; then
    # tag_utils (embedded awk) owns the whole selection policy — the rust-v*
    # filter, stable-preference, and the semver compare itself — so the choice
    # stays inspectable in one place; gh only projects the two fields.
    # rust-vX.Y.Z[-suffix] -> zero-padded numeric key, so plain string
    # comparison orders versions; the stable/prerelease flag prefixes the key
    # so a stable release always beats a prerelease regardless of version.
    TAG="$(gh release list --repo "$REPO" --limit 100 \
      --json tagName,isPrerelease \
      --jq '.[] | "\(.isPrerelease)\t\(.tagName)"' \
      | awk -F '\t' '
          function key(prerelease, tag,  v, a) {
            v = tag; sub(/^rust-v/, "", v); sub(/-.*$/, "", v)
            split(v, a, ".")
            return (prerelease == "false" ? 2 : 1) \
                   sprintf("%03d%03d%03d", a[1]+0, a[2]+0, a[3]+0)
          }
          $2 !~ /^rust-v/ { next }
          { k = key($1, $2); if (k > best) { best = k; best_tag = $2 } }
          END { if (best_tag != "") print best_tag }')" \
      || die "could not list releases in ${REPO} (is gh authenticated?)"
    [ -n "$TAG" ] || die "no rust-v* releases found in ${REPO}"
  fi
else
  api() {
    curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" "$@"
  }
  if [ "$TAG" = "latest" ]; then
    TAG="$(api "https://api.github.com/repos/${REPO}/releases?per_page=100" \
      | python3 -c '
import json, re, sys
best = None
for release in json.load(sys.stdin):
    m = re.match(r"^rust-v(\d+)\.(\d+)\.(\d+)", release.get("tag_name", ""))
    if not m or release.get("draft"):
        continue
    key = (0 if release.get("prerelease") else 1,
           tuple(int(x) for x in m.groups()))
    if best is None or key > best[0]:
        best = (key, release["tag_name"])
print(best[1] if best else "")')"
    [ -n "$TAG" ] || die "no rust-v* releases found in ${REPO}"
  fi
  release_json="$(api "https://api.github.com/repos/${REPO}/releases/tags/${TAG}")"
fi

# --- pick this platform's asset ----------------------------------------------
if [ "$HAVE_GH" = 1 ]; then
  assets="$(gh release view "$TAG" --repo "$REPO" --json assets,tagName \
    --jq '.assets[].name')"
else
  assets="$(printf '%s' "$release_json" | python3 -c '
import json, sys
for asset in json.load(sys.stdin).get("assets", []):
    print(asset["name"])')"
fi
asset="$(printf '%s\n' "$assets" | grep "prime-agent-.*-${TARGET}\.tar\.gz$" | head -n 1)"
[ -n "$asset" ] \
  || die "release ${TAG} has no prime-agent-<version>-${TARGET}.tar.gz asset (assets: $(printf '%s\n' "$assets" | tr '\n' ' '))"
printf '%s\n' "$assets" | grep -qx "SHA256SUMS" \
  || die "release ${TAG} has no SHA256SUMS asset"
echo "installing ${asset} from ${REPO} ${TAG}"

# --- download -----------------------------------------------------------------
dl="$(mktemp -d "${TMPDIR:-/tmp}/prime-agent-rust-download.XXXXXX")"
if [ "$HAVE_GH" = 1 ]; then
  gh release download "$TAG" --repo "$REPO" --dir "$dl" \
    --pattern "$asset" --pattern "SHA256SUMS"
else
  asset_url() {
    printf '%s' "$release_json" | python3 -c '
import json, sys
for a in json.load(sys.stdin).get("assets", []):
    if a["name"] == sys.argv[1]:
        print(a["browser_download_url"])
        break' "$1"
  }
  for name in "$asset" SHA256SUMS; do
    url="$(asset_url "$name")"
    [ -n "$url" ] || die "no download URL for ${name} in ${TAG}"
    curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -o "${dl}/${name}" "$url"
  done
fi

# --- verify the checksum -------------------------------------------------------
# The release's SHA256SUMS carries one line per platform (merged from the
# per-target build jobs); verify only this platform's line.
line="$(grep "  ${asset}\$" "$dl/SHA256SUMS" || true)"
[ -n "$line" ] || die "SHA256SUMS in ${TAG} has no line for ${asset}"
printf '%s\n' "$line" > "$dl/SHA256SUMS.check"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$dl" && sha256sum -c SHA256SUMS.check) \
    || die "checksum mismatch for ${asset}: the download is corrupt; re-run the installer"
elif command -v shasum >/dev/null 2>&1; then
  (cd "$dl" && shasum -a 256 -c SHA256SUMS.check) \
    || die "checksum mismatch for ${asset}: the download is corrupt; re-run the installer"
else
  die "no sha256 tool found (sha256sum or shasum is required to verify the download)"
fi

# --- install ---------------------------------------------------------------------
share_dir="${PREFIX}/share/prime-agent-rust"
bin_dir="${PREFIX}/bin"
launcher="${bin_dir}/prime-agent-rust"
mkdir -p "${PREFIX}/share" "${bin_dir}"

# Extract to a staging dir inside the prefix (same filesystem, so the final
# swap is a rename, not a cross-device copy), then replace the previous
# install with rm + mv. No backups: re-running this script is the update
# path, and the launcher is only pointed at a fully-extracted tree either way.
stage="$(mktemp -d "${PREFIX}/share/prime-agent-rust.stage.XXXXXX")"
tar -xzf "${dl}/${asset}" -C "$stage"
[ -x "${stage}/prime-agent" ] \
  || die "the tarball did not contain an executable prime-agent payload"
rm -rf "$share_dir"
mv "$stage" "$share_dir"

# --- the launcher (the cohabitation contract lives here) -------------------------
# Every line is load-bearing:
cat > "$launcher" <<EOF
#!/bin/sh
# prime-agent-rust — launcher written by install-rust.sh.
# The session store is shared with the TypeScript product BY DESIGN: both
# read and write the same \$HOME/.prime/agent (sessions and their leases),
# so the same sessions appear in both products. The env keeps the TS
# product's default while allowing the usual overrides.
export PRIME_AGENT_CODING_AGENT_DIR="\${PRIME_AGENT_CODING_AGENT_DIR:-\$HOME/.prime/agent}"
# This daemon's OWN socket: the products share the store, NOT the daemon —
# their daemon schema ids differ, so without this pin the Rust CLI would
# treat the TypeScript daemon as stale and shut it down when idle. This
# build honors the env (flag > env > default).
export PRIME_AGENT_DAEMON_SOCKET="\${PRIME_AGENT_DAEMON_SOCKET:-\${TMPDIR:-/tmp}/prime-agent-rust/daemon.sock}"
exec "${share_dir}/prime-agent" "\$@"
EOF
chmod 0755 "$launcher"

# --- PATH check (warn, not fail) ---------------------------------------------------
case ":$PATH:" in
  *":${bin_dir}:"*) ;;
  *)
    echo "note: ${bin_dir} is not on your PATH; add it to your shell profile:"
    printf "  export PATH=\"%s:\$PATH\"\n" "$bin_dir"
    ;;
esac

# --- verify: the launcher must answer --version -----------------------------------
# Tried once. The common failure on a fresh install is the first-run kernel
# venv bootstrap (the sidecar provisions itself on first launch), so the
# failure prints the output plus a re-run hint instead of failing the
# install over it.
if version_out="$("$launcher" --version 2>&1)"; then
  echo "installed: ${version_out}"
else
  echo "warning: the first --version run failed (output below); the first run"
  echo "bootstraps the kernel venv — re-run it:"
  printf '%s\n' "$version_out"
  echo "  ${launcher} --version"
fi
echo "launcher: ${launcher}"
echo "payload:  ${share_dir}"

# --- cohabitation note --------------------------------------------------------------
if command -v prime-agent >/dev/null 2>&1; then
  echo "note: a 'prime-agent' (TypeScript) binary is on PATH — it was NOT touched;"
  echo "both products run side by side and share the session store."
fi

echo "next steps: docs/RUST_QUICKSTART.md ships inside the payload"
echo "  ${share_dir}/docs/RUST_QUICKSTART.md"

rm -rf "$dl"
