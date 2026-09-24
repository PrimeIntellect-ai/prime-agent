#!/bin/sh
# install-rust.sh — one-command installer for the Rust build of Prime Agent.
#
# SOURCE: the `continuous` workflow's build artifacts (every push to the
# `rust` branch builds the matrix; this script installs the latest
# successful run's platform tarball). No tags, no GitHub releases: the
# repo's release history belongs to the TypeScript product, and the Rust
# port's versioned releases come when it graduates
# (prime-agent-design/RELEASE_SECURITY.md).
#
# What it installs: one continuous build's payload (the prime-agent
# binary, prime-agent-runtime/ kernel sidecar, skills/, docs/, LICENSE,
# README.md, and the commit-stamped package.json) under
# $PRIME_AGENT_RUST_PREFIX/share/prime-agent-rust/, plus a
# prime-agent-rust launcher in $PRIME_AGENT_RUST_PREFIX/bin/. The
# installed binary answers its exact source commit via --version
# (<workspace-version>-continuous.<commit-sha>).
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
#   PRIME_AGENT_RUST_RUN     the continuous workflow run id to install
#                            (default: "latest" — the newest successful
#                            run on the `rust` branch)
#   PRIME_AGENT_RUST_PREFIX  install prefix (default: ~/.local)
#
# Authentication is mandatory even though the repo is public: GitHub's
# workflow-artifact DOWNLOAD API requires an authenticated principal (an
# anonymous request answers 401). `gh` is used when on PATH; otherwise
# GITHUB_TOKEN must be set and the REST API is called with curl (python3
# unzips the artifact — POSIX sh has no unzip, and the product itself
# needs a Python runtime for its kernel sidecar, so the dependency adds
# nothing the product does not already require).
set -eu

REPO="${PRIME_AGENT_RUST_REPO:-PrimeIntellect-ai/prime-agent}"
RUN="${PRIME_AGENT_RUST_RUN:-latest}"
PREFIX="${PRIME_AGENT_RUST_PREFIX:-$HOME/.local}"
WORKFLOW="continuous"
BRANCH="rust"

die() { echo "install-rust.sh: $1" >&2; exit 1; }

# --- platform detection ----------------------------------------------------
# uname -m maps directly to the built target: an Apple-Silicon Mac whose
# shell (and therefore binaries) run under Rosetta 2 reports x86_64 and
# gets the x86_64 build, which is the correct build for that runtime.
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS:$ARCH" in
  Darwin:arm64) TARGET=aarch64-apple-darwin ;;
  Darwin:x86_64) TARGET=x86_64-apple-darwin ;;
  Linux:x86_64) TARGET=x86_64-unknown-linux-gnu ;;
  Linux:aarch64) TARGET=aarch64-unknown-linux-gnu ;;
  *)
    die "no rust build is published for ${OS} ${ARCH} (detected via uname);
the continuous workflow builds aarch64-apple-darwin, x86_64-apple-darwin,
aarch64-unknown-linux-gnu, and x86_64-unknown-linux-gnu"
    ;;
esac

# --- auth (workflow-artifact downloads require a principal) ----------------
if command -v gh >/dev/null 2>&1; then
  HAVE_GH=1
else
  HAVE_GH=0
  [ -n "${GITHUB_TOKEN:-}" ] \
    || die "workflow-artifact downloads need authentication; install/use gh or set GITHUB_TOKEN"
fi

# --- resolve the continuous run --------------------------------------------
# The default takes the newest SUCCESSFUL run of the continuous workflow
# on the rust branch — the run whose artifacts carry the freshest commit
# that passed the build. PRIME_AGENT_RUST_RUN pins an exact run instead
# (the id from the run page URL).
if [ "$HAVE_GH" = 1 ]; then
  if [ "$RUN" = "latest" ]; then
    # An empty run list makes jq print the literal "null" - refuse it
    # here instead of passing a bogus id to the download.
    RUN="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$BRANCH" \
      --status success --limit 1 --json databaseId \
      --jq '.[0].databaseId')" \
      || die "could not list ${WORKFLOW} runs in ${REPO} (is gh authenticated?)"
  fi
  [ -n "$RUN" ] && [ "$RUN" != "null" ] \
    || die "no successful ${WORKFLOW} run found on ${BRANCH} in ${REPO}"
else
  api() {
    curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" "$@"
  }
  if [ "$RUN" = "latest" ]; then
    RUN="$(api "https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}.yml/runs?branch=${BRANCH}&status=success&per_page=1" \
      | python3 -c 'import json, sys; print(json.load(sys.stdin)["workflow_runs"][0]["id"])')" \
      || die "could not list ${WORKFLOW} runs in ${REPO} (check GITHUB_TOKEN)"
  fi
fi
echo "installing the ${WORKFLOW} run ${RUN} ${TARGET} artifact from ${REPO}"

# --- download the platform artifact -----------------------------------------
# The artifact zip is flat (the build job uploads the assembled dist tree),
# so the download carries the platform tarball, its SHA256SUMS line, and
# the run's manifest.json (with the exact commit).
dl="$(mktemp -d "${TMPDIR:-/tmp}/prime-agent-rust-download.XXXXXX")"
if [ "$HAVE_GH" = 1 ]; then
  gh run download "$RUN" --repo "$REPO" \
    --name "artifacts-${TARGET}" --dir "$dl" \
    || die "artifact artifacts-${TARGET} not found in run ${RUN} (is the build matrix up?)"
else
  artifact_id="$(api "https://api.github.com/repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100" \
    | python3 -c '
import json, sys
name = "artifacts-" + sys.argv[1]
for artifact in json.load(sys.stdin).get("artifacts", []):
    if artifact["name"] == name:
        print(artifact["id"])
        break' "$TARGET")"
  [ -n "${artifact_id:-}" ] \
    || die "artifact artifacts-${TARGET} not found in run ${RUN}"
  curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -o "${dl}/artifact.zip" \
    "https://api.github.com/repos/${REPO}/actions/artifacts/${artifact_id}/zip" \
    || die "could not download artifact ${artifact_id} from run ${RUN}"
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' \
    "${dl}/artifact.zip" "$dl"
  rm -f "${dl}/artifact.zip"
fi
asset="$(printf '%s\n' "$dl"/*.tar.gz 2>/dev/null | head -n 1)"
[ -n "$asset" ] \
  || die "the ${TARGET} artifact of run ${RUN} carried no platform tarball"
asset_name="${asset##*/}"
[ -f "$dl/SHA256SUMS" ] \
  || die "the ${TARGET} artifact of run ${RUN} carried no SHA256SUMS"

# --- verify the checksum -------------------------------------------------------
# The artifact's own SHA256SUMS covers the tarball the build produced; the
# verification happens before extraction, so a truncated or tampered
# download refuses to install. (The checksum rides the same channel as the
# tarball — the known same-channel limitation; the signed-asset design is
# the graduation path in RELEASE_SECURITY.md.)
line="$(grep "  ${asset_name}\$" "$dl/SHA256SUMS" || true)"
[ -n "$line" ] || die "SHA256SUMS in run ${RUN} has no line for ${asset_name}"
printf '%s\n' "$line" > "$dl/SHA256SUMS.check"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$dl" && sha256sum -c SHA256SUMS.check) \
    || die "checksum mismatch for ${asset_name}: the download is corrupt; re-run the installer"
elif command -v shasum >/dev/null 2>&1; then
  (cd "$dl" && shasum -a 256 -c SHA256SUMS.check) \
    || die "checksum mismatch for ${asset_name}: the download is corrupt; re-run the installer"
else
  die "no sha256 tool found (sha256sum or shasum is required to verify the download)"
fi
commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("commit", ""))' "$dl/manifest.json" 2>/dev/null || true)"
echo "checksum verified: ${asset_name} (built from ${commit:-unknown commit})"

# --- install ---------------------------------------------------------------------
share_dir="${PREFIX}/share/prime-agent-rust"
bin_dir="${PREFIX}/bin"
launcher="${bin_dir}/prime-agent-rust"
mkdir -p "${PREFIX}/share" "${bin_dir}"

# Extract to a staging dir inside the prefix (same filesystem, so the final
# swap is a rename, not a cross-device copy). Publication is SERIALIZED
# behind an atomic symlink lock: the claim is `ln -s <pid>` - ONE
# operation that carries the holder's identity, and the ln itself is the
# single winner (every other waiter fails against the existing link), so
# two installers can never both enter the publish section. A lock whose
# holder is DEAD (a crashed install - the cleanup trap cannot run under
# SIGKILL) is never auto-stolen: a waiter that dropped a dead lock would
# race other waiters into a double publish, so it dies with the one-line
# manual recovery instead. The old tree is renamed ASIDE first and
# removed only after the new stage is in place, so the live tree is
# never rm'd while the launcher still points into it.
stage="$(mktemp -d "${PREFIX}/share/prime-agent-rust.stage.XXXXXX")"
tar -xzf "$asset" -C "$stage"
[ -x "${stage}/prime-agent" ] \
  || die "the tarball did not contain an executable prime-agent payload"
lock_link="${PREFIX}/share/.prime-agent-rust-install.lock"
until ln -s $$ "$lock_link" 2>/dev/null; do
  held_by="$(readlink "$lock_link" 2>/dev/null || true)"
  if [ -n "$held_by" ] && kill -0 "$held_by" 2>/dev/null; then
    die "another install-rust.sh (pid ${held_by}) is publishing to ${PREFIX}; retry when it finishes"
  fi
  die "a previous install-rust.sh (pid ${held_by:-unknown}) left a stale publication lock (a crashed install; its cleanup trap cannot have run). Remove it and retry:
  rm -f ${lock_link}"
done
trap 'rm -f "$lock_link"' EXIT
old="${PREFIX}/share/prime-agent-rust.old.$$"
if [ -d "$share_dir" ]; then
  mv "$share_dir" "$old"
fi
if ! mv "$stage" "$share_dir"; then
  if [ -d "$old" ]; then mv "$old" "$share_dir"; fi   # put the old tree back
  die "could not publish ${share_dir}"
fi
rm -rf "$old"
rm -rf "${PREFIX}"/share/prime-agent-rust.old.* 2>/dev/null || true

# --- the launcher (the cohabitation contract lives here) -------------------------
# Every line is load-bearing. The heredoc is QUOTED ('EOF'): the launcher
# is written literally, with NOTHING expanded at install time - the exec
# path resolves from the launcher's own location at launch (the payload
# rides ../share/ from wherever the prefix placed the binary), the
# per-user socket suffix runs at launch, and a prefix containing shell
# syntax can never end up reparsed inside this generated script.
# The launcher is written to a temp file in bin_dir and renamed into place:
# an interrupted write leaves the PREVIOUS launcher intact instead of a
# truncated one (the payload is already published by this point).
launcher_tmp="$(mktemp "${bin_dir}/.prime-agent-rust.XXXXXX")"
cat > "$launcher_tmp" <<'EOF'
#!/bin/sh
# prime-agent-rust — launcher written by install-rust.sh.
# The session store is shared with the TypeScript product BY DESIGN: both
# read and write the same $HOME/.prime/agent (sessions and their leases),
# so the same sessions appear in both products. The env keeps the TS
# product's default while allowing the usual overrides.
export PRIME_AGENT_CODING_AGENT_DIR="${PRIME_AGENT_CODING_AGENT_DIR:-$HOME/.prime/agent}"
# This daemon's OWN socket: the products share the store, NOT the daemon —
# their daemon schema ids differ, so without this pin the Rust CLI would
# treat the TypeScript daemon as stale and shut it down when idle. This
# build honors the env (flag > env > default). The default is per-user
# (the uid suffix), like the product's own per-user default socket.
export PRIME_AGENT_DAEMON_SOCKET="${PRIME_AGENT_DAEMON_SOCKET:-${TMPDIR:-/tmp}/prime-agent-rust-$(id -u)/daemon.sock}"
exec "$(dirname "$0")/../share/prime-agent-rust/prime-agent" "$@"
EOF
chmod 0755 "$launcher_tmp"
mv -f "$launcher_tmp" "$launcher"

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
echo "launcher:  ${launcher}"
echo "payload:   ${share_dir}"
echo "source:    ${WORKFLOW} run ${RUN} (commit ${commit:-unknown})"

# --- cohabitation note --------------------------------------------------------------
if command -v prime-agent >/dev/null 2>&1; then
  echo "note: a 'prime-agent' (TypeScript) binary is on PATH — it was NOT touched;"
  echo "both products run side by side and share the session store."
fi

echo "next steps: docs/RUST_QUICKSTART.md ships inside the payload"
echo "  ${share_dir}/docs/RUST_QUICKSTART.md"

rm -rf "$dl"
