#!/bin/sh
# install-rust.sh — one-command installer for the Rust build of Prime Agent.
#
# THE KEYWORD TAKEOVER: the Rust port installs under the product keyword
# PRIME-AGENT — the launcher lands at ~/.local/bin/prime-agent, the payload
# at ~/.local/share/prime-agent/, and users type `prime-agent`. The old
# prime-agent-rust layout (a TS-safe side-by-side name) is migrated: the
# share tree moves to the new name with a one-generation .old rollback, and
# this script's own launcher replaces the prime-agent-rust one it wrote in
# past installs. The FILENAME stays install-rust.sh deliberately: the
# curl|sh URL and the update entry points (`prime-agent update`, the TUI
# /update — both exec this script with --update) already point at it, and
# the filename is invisible to users; the command they type is what
# changed.
#
# SOURCE: the `continuous` workflow's build artifacts (every push to the
# `rust` branch builds the matrix; this script installs the latest
# successful run's platform tarball). No tags, no GitHub releases: the
# repo's release history belongs to the TypeScript product, and the Rust
# port's versioned releases come when it graduates
# (prime-agent-design/RELEASE_SECURITY.md).
#
# THE TYPESCRIPT TAKEOVER (this script is also the uninstall path for the
# TS product — one installer owns the keyword's lifecycle):
#   1. THE TS DAEMON IS STOPPED CLEANLY, NEVER KILLED, but only AFTER the
#      new payload and launcher are published — the retirement steps
#      (daemon stop, npm uninstall) never leave the machine without a
#      working prime-agent if the install aborts mid-way. The TS daemon's
#      default socket is ${TMPDIR:-/tmp}/prime-agent-$(id -u)/daemon.sock;
#      the installer probes it (and its own rust socket) the same way the
#      schema-id check does: the daemon's hello line carries a schemaId,
#      and only a daemon whose hello answers the TypeScript schema id
#      (protocol-7-schema-29-...) is treated as the TS daemon. Such a
#      daemon gets the product's own stop-when-idle semantics — a session
#      count over `list`, a `shutdown` request ONLY when it is idle, then
#      a 5s confirm poll. A busy daemon is LEFT RUNNING (never signaled;
#      it stops itself when idle), an unknown schema is skipped, and no
#      signal is ever sent to any pid from this script.
#   2. THE TS FILES ARE PRESERVED, NOT DELETED (the pi_agent_rust
#      `legacy-pi` precedent: rollback stays possible). What the TS
#      installer actually created, researched from its install.sh: a
#      managed root at ${XDG_DATA_HOME:-~/.local/share}/prime-agent
#      (marked by .managed = prime-agent-native-v1, holding releases/<v>/
#      trees and its own bin/prime-agent symlink), a public
#      ~/.local/bin/prime-agent symlink into it, an optional global npm
#      package, and an optional standalone node at
#      ~/.local/share/prime-agent-node. The takeover:
#        - a TS managed root occupying THIS script's target
#          ($PREFIX/share/prime-agent) moves to
#          $PREFIX/share/prime-agent-legacy (kept verbatim; rollback =
#          rename back and re-link the public bin symlink);
#        - the public ~/.local/bin/prime-agent is REPLACED by this
#          script's launcher (the keyword is ours now);
#        - the TS npm package is uninstalled (exact package `prime-agent`
#          only; the restore command is printed with the recorded version);
#        - the standalone node dir is LEFT in place (it is a runtime, not
#          the product binary/package — the user can remove it by hand).
#   3. WHY DAEMON CONFLICTS ARE IMPOSSIBLE AFTER THIS INSTALL: the
#      launcher pins a rust-only daemon socket
#      (${TMPDIR:-/tmp}/prime-agent-rust-$(id -u)/daemon.sock) — a
#      different path than the TS daemon's own — so this CLI can never
#      attach to, replace, or be confused with the TS daemon at runtime;
#      and the install-time stop-when-idle above retires a TS daemon
#      cleanly instead of orphaning one. Pin + clean stop together mean
#      the two daemons can never fight over a socket again after install.
#      Together with the kernel pre-warm below (uv + the Python venv at
#      install time), a fresh install's FIRST session works out of the
#      box, online or offline.
#
# THE SHARED STORE IS NEVER TOUCHED: ~/.prime/agent/ (sessions, leases,
# config) is read and written by BOTH products by design — the same
# sessions appear in either — and this installer never creates, renames,
# migrates, or deletes anything under it. guard_preserved() aborts the
# install if any computed path (prefix, bin, share, stage, rollback)
# falls under the store.
#
# Config (env with defaults; the PRIME_AGENT_RUST_* names are unchanged
# from previous releases so existing users' env keeps working — they now
# address the prime-agent bin/dir names):
#   PRIME_AGENT_RUST_REPO    the <org>/<repo> to install from
#                            (default: PrimeIntellect-ai/prime-agent)
#   PRIME_AGENT_RUST_RUN     the continuous workflow run id to install
#                            (default: "latest" — the newest successful
#                            run on the `rust` branch)
#   PRIME_AGENT_RUST_PREFIX  install prefix (default: ~/.local; the
#                            launcher lands at $PREFIX/bin/prime-agent,
#                            the payload at $PREFIX/share/prime-agent/)
#
# Usage: install-rust.sh [--update] — both entry points install the newest
# successful continuous run; the script is idempotent (a re-run replaces
# the payload, keeps one .old rollback generation, and re-runs the
# takeover steps as no-ops when there is nothing left to take over).
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

usage() {
  cat <<'USAGE'
install-rust.sh — install the Rust build of Prime Agent under the prime-agent keyword.

The launcher lands at $PRIME_AGENT_RUST_PREFIX/bin/prime-agent and the payload at
$PRIME_AGENT_RUST_PREFIX/share/prime-agent/ (default prefix ~/.local). The installed
TypeScript product is taken over: its daemon is stopped cleanly when idle, its native
install is preserved under share/prime-agent-legacy, and its npm package is uninstalled
(the restore command is printed). ~/.prime/agent (the shared session store) is never
touched. Both the default and --update install the newest successful `continuous`
workflow run on the `rust` branch.

The installer pre-warms the Python kernel (uv + `prime-agent
--prime-agent-bootstrap`); offline, that step degrades to a warning and the
first session bootstraps the kernel itself — it needs the network once.

Environment:
  PRIME_AGENT_RUST_REPO     <org>/<repo> to install from
  PRIME_AGENT_RUST_RUN      continuous workflow run id ("latest" by default)
  PRIME_AGENT_RUST_PREFIX   install prefix (~/.local by default)
  GITHUB_TOKEN              artifact authentication when gh is not on PATH
USAGE
}

# --- arguments ---------------------------------------------------------------
# No positional arguments. --update is the documented alias the update entry
# points (`prime-agent update`, the TUI /update) exec — identical to the default
# run because the flow is idempotent by construction.
case "${1:-}" in
  "") ;;
  --update) ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; die "unknown argument: ${1}" ;;
esac

# --- the preserve invariant: guard the shared store ---------------------------
# ~/.prime/agent is shared by both products BY DESIGN (sessions, leases,
# config). No step of this installer may write, rename, or delete under it.
# guard_preserved aborts when a target path resolves under the store —
# the realistic trigger is a mis-set PRIME_AGENT_RUST_PREFIX.
# Resolved like PREFIX below: when $HOME is a symlink, a PREFIX spelled in the
# physical form must still compare equal to the store, or the guard would
# pass two different spellings of the same directory.
PRESERVED_STORE="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${HOME}/.prime/agent")"
guard_preserved() {
  for guarded_path in "$@"; do
    case "$guarded_path" in
      "$PRESERVED_STORE"|"$PRESERVED_STORE"/*)
        die "refusing to touch ${guarded_path}: the shared session store
${PRESERVED_STORE} (sessions, leases, config — shared with the TypeScript
product by design) must never be created, migrated, or deleted"
        ;;
    esac
  done
}

# A unique aside/rollback slot. The namespaces can carry entries forever
# (unstamped migrated slots are deliberately kept; pid reuse can revisit a
# name), so a name built from $$ alone can collide — and `mv` into an
# existing directory NESTS instead of replacing. Take the next free suffix.
fresh_slot() { # base name without suffix
  slot="$1.$$"
  n=1
  while [ -e "$slot" ]; do
    n=$((n + 1))
    slot="$1.$$.${n}"
  done
  printf '%s' "$slot"
}

case "$PREFIX" in
  /*) ;;
  *) die "PRIME_AGENT_RUST_PREFIX must be an absolute path: ${PREFIX}" ;;
esac
# Resolve PREFIX FULLY (symlinks included) BEFORE creating anything under
# it: a prefix whose spelling hides a symlink into the shared store must
# abort before mkdir -p ever writes there, not after.
PREFIX="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$PREFIX")"
guard_preserved "$PREFIX" "${PREFIX}/share" "${PREFIX}/bin"
mkdir -p "${PREFIX}/share" "${PREFIX}/bin"
# The guard must also see THROUGH symlinked child roots: a ${PREFIX}/share or
# ${PREFIX}/bin that is a symlink into the shared store would otherwise let
# the publish write under it while every lexical check passes. Resolving the
# children (not refusing them) keeps legitimate out-of-store symlinked roots
# installable while the resolved paths go through the same guard.
for install_root in "${PREFIX}/share" "${PREFIX}/bin"; do
  guard_preserved "$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$install_root")"
done

share_dir="${PREFIX}/share/prime-agent"
bin_dir="${PREFIX}/bin"
launcher="${bin_dir}/prime-agent"
old_layout_dir="${PREFIX}/share/prime-agent-rust"
legacy_dir="${PREFIX}/share/prime-agent-legacy"
lock_link="${PREFIX}/share/.prime-agent-install.lock"
legacy_lock="${PREFIX}/share/.prime-agent-rust-install.lock"
guard_preserved "$share_dir" "$launcher" "$old_layout_dir" "$legacy_dir" "$lock_link"

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

# --- glibc floor (Linux) ------------------------------------------------------
# The continuous workflow builds the GNU/Linux targets inside an
# ubuntu:22.04 (glibc 2.35) container, so the published Linux binaries
# require glibc symbols no newer than 2.35. Refuse installs on older
# glibc (or non-glibc) systems up front with the exact floor instead of
# installing a payload the dynamic loader will refuse to start.
if [ "$OS" = "Linux" ]; then
  ldd_line="$(ldd --version 2>&1 | head -n 1)"
  case "$ldd_line" in
    *musl*) die "musl libc is not supported: the Linux builds are GNU (glibc >= 2.35, Ubuntu 22.04 or newer) binaries" ;;
  esac
  glibc="${ldd_line##* }"
  case "$glibc" in
    [0-9]*.[0-9]*) ;;
    *) die "could not determine the glibc version from: ${ldd_line}
the Linux builds require glibc >= 2.35 (Ubuntu 22.04 or newer)" ;;
  esac
  glibc_major="$(printf '%s' "${glibc%%.*}" | tr -cd '0-9')"
  glibc_minor="$(printf '%s' "${glibc#*.}" | sed 's/\..*//' | tr -cd '0-9')"
  if [ -z "$glibc_major" ] || [ -z "$glibc_minor" ] \
     || [ "$glibc_major" -lt 2 ] \
     || { [ "$glibc_major" -eq 2 ] && [ "$glibc_minor" -lt 35 ]; }; then
    die "glibc ${glibc} is below the supported floor: the Linux builds are
compiled against glibc 2.35 (Ubuntu 22.04) and will not start here"
  fi
  echo "glibc ${glibc} >= 2.35: supported"
fi

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
dl="$(mktemp -d "${TMPDIR:-/tmp}/prime-agent-download.XXXXXX")"
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

# --- the TypeScript takeover, step 1: stop the TS daemon CLEANLY ---------------
# Probe the TS daemon's own socket and this product's pinned socket with the
# same schema-id check the CLI uses: the daemon hello line carries a
# schemaId; only the TypeScript schema id identifies the TS daemon. A TS
# daemon is asked to stop ONLY when idle (the stop-when-idle semantics — a
# `shutdown` request the daemon handles cleanly, closing its sessions with
# resume entries kept); a busy one is left running to drain on its own.
# NOTHING IS EVER KILLED from here: no signal is sent to any pid; an
# unknown schema, a dead socket file, or an unreadable session count all
# skip the stop (the launcher's socket pin already makes conflicts
# impossible, so a skip is safe).
ts_socket="${TMPDIR:-/tmp}/prime-agent-$(id -u)/daemon.sock"
rust_socket="${TMPDIR:-/tmp}/prime-agent-rust-$(id -u)/daemon.sock"
stop_ts_daemon() {
  socket_path="$1"
  [ -e "$socket_path" ] || return 0
  verdict="$(python3 - "$socket_path" <<'PY'
import json, select, socket, sys, time

path = sys.argv[1]
TS_SCHEMA_ID = "protocol-7-schema-29-a5c9d20f8b13"
HELLO_TIMEOUT_S = 1.5
PROBE_TIMEOUT_S = 5.0
STOP_CONFIRM_TIMEOUT_S = 5.0

def read_line(sock, deadline):
    chunks = []
    while time.monotonic() < deadline:
        if select.select([sock], [], [], 0.05)[0]:
            part = sock.recv(4096)
            if not part:
                return None
            chunks.append(part)
            data = b"".join(chunks)
            if b"\n" in data:
                return data.split(b"\n", 1)[0].decode("utf-8", "replace")
    return None

try:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(HELLO_TIMEOUT_S)
    sock.connect(path)
except OSError:
    print("stale")
    sys.exit(0)

hello = None
deadline = time.monotonic() + HELLO_TIMEOUT_S
while time.monotonic() < deadline:
    line = read_line(sock, deadline)
    if line is None:
        break
    try:
        value = json.loads(line)
    except ValueError:
        continue
    if value.get("type") == "daemon_hello":
        hello = value
        break
if hello is None:
    print("no-hello")
    sys.exit(0)
schema = hello.get("schemaId")
if not isinstance(schema, str):
    print("no-schema")
    sys.exit(0)
if schema != TS_SCHEMA_ID:
    print("foreign:" + schema)
    sys.exit(0)

# TS daemon identified: confirm it is idle before asking it to stop. The
# request rides the protocol-7 COMMAND ENVELOPE exactly like the products'
# own clients (the TS supervisor refuses bare commands: "Daemon commands
# require protocol ... or newer" — a bare `list` would kill the probe).
def envelope(request_id, body):
    return json.dumps({
        "type": "command",
        "id": request_id,
        "protocol": {"name": "prime-agent.daemon", "version": 7},
        "clientId": "install-rust-sh",
        "command": dict(body, id=request_id),
    }) + "\n"

sock.sendall(envelope("installer-probe", {"type": "list"}).encode())
deadline = time.monotonic() + PROBE_TIMEOUT_S
count = None
while time.monotonic() < deadline:
    line = read_line(sock, deadline)
    if line is None:
        break
    try:
        value = json.loads(line)
    except ValueError:
        continue
    if value.get("type") == "response" and value.get("id") == "installer-probe":
        sessions = (value.get("data") or {}).get("sessions")
        count = len(sessions) if isinstance(sessions, list) else None
        break
if count is None:
    print("ts:probe-failed")
    sys.exit(0)
if count != 0:
    print("ts:busy:%d" % count)
    sys.exit(0)

# Idle: ask for a clean stop (force:false — the graceful path, never a kill),
# let the daemon ack, then confirm it stopped listening.
sock.sendall(envelope("installer-stop", {"type": "shutdown", "force": False}).encode())
ack_deadline = time.monotonic() + PROBE_TIMEOUT_S
while time.monotonic() < ack_deadline:
    line = read_line(sock, ack_deadline)
    if line is None:
        break
    try:
        value = json.loads(line)
    except ValueError:
        continue
    if value.get("type") == "response" and value.get("id") == "installer-stop":
        break
sock.close()
end = time.monotonic() + STOP_CONFIRM_TIMEOUT_S
while time.monotonic() < end:
    try:
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.settimeout(0.25)
        probe.connect(path)
        probe.close()
    except OSError:
        print("ts:stopped")
        sys.exit(0)
    time.sleep(0.05)
print("ts:stop-failed")
PY
)" || verdict="probe-error"
  case "$verdict" in
    ts:stopped)
      echo "the TypeScript daemon on ${socket_path} stopped cleanly (idle; no signal sent)"
      ;;
    ts:busy:*)
      sessions="${verdict#ts:busy:}"
      echo "note: the TypeScript daemon on ${socket_path} is serving ${sessions} session(s);"
      echo "  it was left running (never killed) and stops itself when idle. The Rust"
      echo "  launcher pins its own socket, so the two daemons cannot conflict."
      ;;
    ts:probe-failed)
      echo "note: the TypeScript daemon on ${socket_path} did not answer the idle probe;"
      echo "  it was left running (never killed)."
      ;;
    ts:stop-failed)
      echo "note: the TypeScript daemon on ${socket_path} was asked to stop cleanly but is"
      echo "  still listening after 5s; it was NOT killed — it will drain on its own,"
      echo "  or run 'prime-agent shutdown --force' (the shared-state-root sweep) to stop it."
      ;;
    foreign:*)
      echo "note: a daemon is listening on ${socket_path} but its hello schema"
      echo "  (${verdict#foreign:}) is not the TypeScript daemon's; nothing was done."
      ;;
    stale)
      echo "note: no daemon answers on ${socket_path} (a stale socket file was left alone)"
      ;;
    no-hello|no-schema)
      echo "note: whatever listens on ${socket_path} did not greet with a schema id;"
      echo "  nothing was done (the installer only stops what identifies itself)."
      ;;
    probe-error|"")
      echo "note: could not probe ${socket_path}; nothing was done (never killed blind)."
      ;;
  esac
}
# The stop itself runs in the COMPLETION section after the publish (below):
# a failed install must never leave the machine with its TS daemon stopped
# and no Rust replacement published.

# --- the TypeScript takeover, step 2: the files -------------------------------
# ts_managed_root: the directory the TS installer owns (its .managed marker).
ts_managed_root="${XDG_DATA_HOME:-${HOME}/.local/share}/prime-agent"
ts_managed() {
  [ -f "$1/.managed" ] && [ "$(cat "$1/.managed" 2>/dev/null)" = "prime-agent-native-v1" ]
}

# The pre-takeover layout's ownership shape: the old installer always
# published the binary beside prime-agent-runtime/ (RELEASE_ASSETS) — the
# move AND the leftover sweep use the same rule, so a tree one path refuses
# is never deleted by the other.
ts_owned_old_layout() {
  [ -x "$1/prime-agent" ] \
    && [ -d "$1/prime-agent-runtime" ] \
    && ! ts_managed "$1"
}

# A TS managed root elsewhere (XDG_DATA_HOME) does not block this install and
# is left in place — only the keyword is taken over.
if [ "$ts_managed_root" != "$share_dir" ] && [ -d "$ts_managed_root" ] && ts_managed "$ts_managed_root"; then
  echo "note: a TypeScript native install also lives at ${ts_managed_root}"
  echo "  (XDG_DATA_HOME); it does not occupy ${share_dir} and was left in place."
fi

# --- install ---------------------------------------------------------------------
# Extract to a staging dir inside the prefix (same filesystem, so the final
# swap is a rename, not a cross-device copy). Publication is SERIALIZED
# behind an atomic symlink lock: the claim is `ln -s <pid>` - ONE operation
# that carries the holder's identity, and the ln itself is the single winner
# (every other waiter fails against the existing link), so two installers
# can never both enter the publish section. A lock whose holder is DEAD (a
# crashed install - the cleanup trap cannot run under SIGKILL) is never
# auto-stolen: a waiter that dropped a dead lock would race other waiters
# into a double publish, so it dies with the one-line manual recovery
# instead. The old tree is renamed ASIDE first and removed only after the
# new stage is in place, so the live tree is never rm'd while the launcher
# still points into it. The renamed-aside tree is KEPT as a one-generation
# rollback (prime-agent.old.<pid>); the next successful install sweeps it.
stage="$(mktemp -d "${PREFIX}/share/prime-agent.stage.XXXXXX")"
guard_preserved "$stage"
tar -xzf "$asset" -C "$stage"
[ -x "${stage}/prime-agent" ] \
  || die "the tarball did not contain an executable prime-agent payload"
# The ownership marker: the share tree this script publishes carries it, so
# later installs recognize the tree as theirs BY MARKER, not by shape — an
# unrelated directory that happens to contain a `prime-agent` entry is never
# adopted, moved aside, or swept (the refusal below sends it back to the
# user instead).
printf 'install-rust.sh continuous run %s\ncommit %s\n' "$RUN" "${commit:-unknown}" \
  > "${stage}/.prime-agent-install"

# A lock left by the pre-takeover installer (name .prime-agent-rust-install.lock):
# a live holder still owns the publish, a dead one can never publish again —
# remove it and take the new-name lock (this run is serialized against every
# other new installer by the lock below).
# -L, not -e: the lock is a symlink whose TARGET is the holder's pid —
# always a dangling symlink, so -e alone would MISS A LIVE legacy installer.
if [ -e "$legacy_lock" ] || [ -L "$legacy_lock" ]; then
  held_by="$(readlink "$legacy_lock" 2>/dev/null || true)"
  if [ -n "$held_by" ] && kill -0 "$held_by" 2>/dev/null; then
    die "an older prime-agent-rust installer (pid ${held_by}) is publishing to ${PREFIX}; retry when it finishes"
  fi
  rm -f "$legacy_lock"
fi
until ln -s $$ "$lock_link" 2>/dev/null; do
  held_by="$(readlink "$lock_link" 2>/dev/null || true)"
  if [ -n "$held_by" ] && kill -0 "$held_by" 2>/dev/null; then
    die "another install-rust.sh (pid ${held_by}) is publishing to ${PREFIX}; retry when it finishes"
  fi
  die "a previous install-rust.sh (pid ${held_by:-unknown}) left a stale publication lock (a crashed install; its cleanup trap cannot have run). Remove it and retry:
  rm -f ${lock_link}"
done
launcher_tmp=""
displaced_ts_root=""
preserved_launcher=""
migrated_old_layout=""
migrated_old_layout=""
on_exit() {
  # Restores FIRST, lock release LAST: a second installer must not be able
  # to publish into share_dir while this one still restores state — the
  # restore would delete that fresh payload (cross-installer data loss).
  [ -n "$launcher_tmp" ] && rm -f "$launcher_tmp" 2>/dev/null || true
  # The user's unowned command file goes home if the Rust launcher never
  # went live (the same restore discipline as the displaced TS tree): a
  # failed launcher write must not leave the machine without ANY
  # prime-agent command.
  if [ -n "$preserved_launcher" ]; then
    if mv "$preserved_launcher" "$launcher" 2>/dev/null; then
      echo "note: the existing prime-agent command was restored to ${launcher} — the install did not complete" >&2
    fi
    preserved_launcher=""
  fi
  # A migrated old-layout tree goes home the same way: the pre-takeover
  # launcher (bin/prime-agent-rust) still points at the old name until this
  # install's launcher section retires it, so an interrupted migration must
  # put the tree back or that command breaks.
  if [ -n "$migrated_old_layout" ] && [ -d "$migrated_old_layout" ] && [ ! -d "$old_layout_dir" ]; then
    if mv "$migrated_old_layout" "$old_layout_dir" 2>/dev/null; then
      echo "note: the prime-agent-rust tree was restored to ${old_layout_dir} — the install did not complete" >&2
    fi
    migrated_old_layout=""
  fi
  restore_ts_root
  rm -f "$lock_link"
}
trap on_exit EXIT

# Sweep rollback generations from PREVIOUS installs (both name eras) before
# this run creates its own — exactly one .old generation survives each install.
# A generation is swept only when BOTH hold: it carries this installer's
# .prime-agent-install marker AND its exact path is in the generations record
# (${PREFIX}/share/.prime-agent-install-generations — written when the slot was
# created, OUTSIDE the payload tree). The marker alone proves the TREE is a
# payload, not that the SLOT is a rollback generation: a user who COPIES the
# payload into the namespace (marker and all) keeps their copy. Pre-takeover-era
# crash leftovers (prime-agent-rust.old.*, never stamped) are left in place —
# harmless, and the user's to remove.
generations_record="${PREFIX}/share/.prime-agent-install-generations"
for sweep_dir in "${PREFIX}"/share/prime-agent.old.* "${PREFIX}"/share/prime-agent-rust.old.*; do
  [ -d "$sweep_dir" ] || continue
  [ -f "${sweep_dir}/.prime-agent-install" ] || continue
  grep -qxF -- "$sweep_dir" "$generations_record" 2>/dev/null || continue
  # Best-effort: an un-sweepable generation (a mounted dir, a permission
  # wall) must not abort the install — the leftover is harmless.
  if ! rm -rf "$sweep_dir" 2>/dev/null; then
    echo "warning: could not sweep the previous rollback generation ${sweep_dir};"
    echo "  it stays (harmless — remove it by hand if you recognize it)"
  fi
done

# The TypeScript takeover, inside the lock: preserve a TS managed root that
# occupies this installer's share dir under a legacy name (Pi's legacy-pi
# precedent), never delete it. Rollback = rename back and re-link the
# public bin symlink. The keyword changes hands either way: the launcher
# write below replaces the TS public symlink. While the displaced tree sits
# in the legacy slot, `displaced_ts_root` names it: every failure from here
# until the Rust launcher is live puts it BACK (restore_ts_root, wired into
# the EXIT trap), so a half-finished install never leaves the machine with
# no working prime-agent — the TS public symlink keeps resolving the whole
# time and the TS tree returns to its original path if this install dies.
restore_ts_root() {
  if [ -n "$displaced_ts_root" ]; then
    if [ -d "$share_dir" ]; then
      # The half-installed Rust payload occupies the TS root's old path: it
      # is disposable (a re-download restores it); the TS tree is not.
      rm -rf "$share_dir"
    fi
    if mv "$displaced_ts_root" "$share_dir" 2>/dev/null; then
      echo "note: the TypeScript install was restored to ${share_dir} — the install did not complete" >&2
    else
      echo "warning: could not restore the TypeScript install from ${displaced_ts_root}; restore it with: mv '${displaced_ts_root}' '${share_dir}'" >&2
    fi
    displaced_ts_root=""
  fi
}
if [ -d "$share_dir" ] && ts_managed "$share_dir"; then
  preserved_to="$legacy_dir"
  if [ -e "$preserved_to" ]; then preserved_to="$(fresh_slot "$legacy_dir")"; fi
  guard_preserved "$preserved_to"
  mv "$share_dir" "$preserved_to" \
    || die "could not preserve the TypeScript install at ${share_dir}; nothing was deleted — resolve and re-run"
  displaced_ts_root="$preserved_to"
  echo "the TypeScript native install at ${share_dir} was preserved at:"
  echo "  ${preserved_to}"
  echo "  rollback: mv '${preserved_to}' '${share_dir}' &&"
  echo "            ln -snf '${share_dir}/bin/prime-agent' '${launcher}'"
fi

# Refuse to take ownership of a share dir that is neither this installer's
# marked payload tree nor the TS managed root (the TS installer's own rule:
# never adopt a nonempty directory you do not own). Only a tree carrying the
# .prime-agent-install marker is claimed — an unowned tree is never moved
# aside, where the next install's rollback sweep would delete it.
if [ -d "$share_dir" ]; then
  if [ -f "${share_dir}/.prime-agent-install" ]; then
    :   # this installer's own previous tree: the normal update path below
  elif [ -z "$(ls -A "$share_dir" 2>/dev/null)" ]; then
    rmdir "$share_dir"
  else
    die "refusing to take ownership of ${share_dir}: it is neither this
installer's marked payload tree (.prime-agent-install) nor the TypeScript
installer's managed root; move it aside and re-run"
  fi
fi

old="$(fresh_slot "${PREFIX}/share/prime-agent.old")"
guard_preserved "$old"
had_share_dir=0
# Migration from the pre-takeover layout: an old share/prime-agent-rust tree
# becomes this run's rollback (the install migrates to the new name).
if [ -d "$old_layout_dir" ] && [ ! -d "$share_dir" ]; then
  # The pre-takeover script stamped nothing, so ownership here is a SHAPE
  # claim (its payload always shipped the binary beside prime-agent-runtime/),
  # never a marker: the slot is moved but deliberately NOT stamped — a
  # shape check is not proof of ownership, so nothing the sweep can
  # auto-delete ever rides on it. The migrated tree is PRESERVED in its
  # .old slot (the user removes it when they are done with the rollback).
  if ! ts_owned_old_layout "$old_layout_dir"; then
    # Not our tree and not the publish target: leave it in place and
    # continue — an unrecognized or partial directory at the old name must
    # not block installing into ${share_dir} (the same rule the leftover
    # path applies after the publish).
    echo "note: ${old_layout_dir} is not this installer's payload tree; it was"
    echo "  left in place (no migration, no rollback from it)"
  else
    mv "$old_layout_dir" "$old"
    migrated_old_layout="$old"
    echo "the old prime-agent-rust install migrated to the rollback slot ${old}"
    echo "  (it is kept — the sweep only removes marker-stamped generations; remove"
    echo "   the slot by hand once you no longer need the rollback)"
  fi
fi
if [ -d "$share_dir" ]; then
  had_share_dir=1
  mv "$share_dir" "$old"
  # The slot is a rollback generation this installer created: record its
  # exact path so the next install's sweep can tell it from a user-made
  # copy of the payload (the record rides OUTSIDE the tree).
  printf '%s\n' "$old" >> "${PREFIX}/share/.prime-agent-install-generations"
fi
if ! mv "$stage" "$share_dir"; then
  if [ "$had_share_dir" = 1 ] && [ -d "$old" ]; then
    mv "$old" "$share_dir"      # put the old tree back
  fi
  die "could not publish ${share_dir}"
  # (a failed migration restore is the EXIT trap's job: it holds the lock
  # until the tree is back, so no second installer can slip in between)
fi
# A leftover old-layout tree when a new-layout tree also existed: it is
# superseded by the fresh publish. The ownership rule is EXACTLY the
# migration's (the pre-takeover payload always shipped the binary beside
# prime-agent-runtime/) — a tree the migration would refuse is never
# deleted here either; it is left in place with a note instead. Best-effort:
# the payload is already live, so an un-removable leftover warns, not dies.
if [ -d "$old_layout_dir" ] && ts_owned_old_layout "$old_layout_dir"; then
  if ! rm -rf "$old_layout_dir" 2>/dev/null; then
    echo "warning: could not remove the superseded ${old_layout_dir} tree; remove it by hand"
  else
    echo "removed the superseded ${old_layout_dir} tree (its payload now lives under ${share_dir})"
  fi
elif [ -d "$old_layout_dir" ]; then
  echo "note: ${old_layout_dir} is not this installer's payload tree; it was left in place"
fi

# --- the launcher (the takeover lives here) -----------------------------------
# Every line is load-bearing. The heredoc is QUOTED ('EOF'): the launcher
# is written literally, with NOTHING expanded at install time - the exec
# path resolves from the launcher's own location at launch (the payload
# rides ../share/ from wherever the prefix placed the binary), the
# per-user socket suffix runs at launch, and a prefix containing shell
# syntax can never end up reparsed inside this generated script.
# The launcher REPLACES whatever occupied ~/.local/bin/prime-agent — on a
# TS machine that path was the TS installer's public symlink; the keyword
# is the Rust port's now (the TS tree itself was preserved above). An
# UNOWNED regular file at the path is not silently destroyed: it is moved
# aside first, so nothing this script did not write is ever lost.
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  if [ -L "$launcher" ]; then
    echo "replacing the prime-agent command symlink (was: $(readlink "$launcher" 2>/dev/null || true));"
    echo "  the keyword is the Rust port's now"
  elif [ -f "$launcher" ] && grep -q 'launcher written by install-rust.sh' "$launcher" 2>/dev/null; then
    :   # this installer's own previous launcher (a REGULAR file — the
    :   # marker grep never opens a special file): plain replace below
  else
    preserved_cmd_path="$(fresh_slot "${bin_dir}/prime-agent.pre-takeover")"
    mv "$launcher" "$preserved_cmd_path" \
      || die "could not preserve the existing file at ${launcher}; resolve it and re-run"
    preserved_launcher="$preserved_cmd_path"
    echo "note: an unrelated prime-agent command existed at ${launcher};"
    echo "  it was preserved at ${preserved_cmd_path}"
  fi
fi
launcher_tmp="$(mktemp "${bin_dir}/.prime-agent.XXXXXX")"
cat > "$launcher_tmp" <<'EOF'
#!/bin/sh
# prime-agent — launcher written by install-rust.sh.
# The session store is shared with the TypeScript product BY DESIGN: both
# read and write the same $HOME/.prime/agent (sessions and their leases),
# so the same sessions appear in both products. The env keeps the TS
# product's default while allowing the usual overrides.
export PRIME_AGENT_CODING_AGENT_DIR="${PRIME_AGENT_CODING_AGENT_DIR:-$HOME/.prime/agent}"
# This daemon's OWN socket: the products share the store, NOT the daemon —
# their daemon schema ids differ, so without this pin the Rust CLI would
# treat the TypeScript daemon as stale and shut it down when idle. This
# build honors the env (flag > env > default). The default is per-user
# (the uid suffix) and rust-only: it never collides with the TypeScript
# daemon's own ${TMPDIR}/prime-agent-$(id -u) socket, so after the
# installer's clean TS-daemon stop the two daemons cannot fight again.
export PRIME_AGENT_DAEMON_SOCKET="${PRIME_AGENT_DAEMON_SOCKET:-${TMPDIR:-/tmp}/prime-agent-rust-$(id -u)/daemon.sock}"
exec "$(dirname "$0")/../share/prime-agent/prime-agent" "$@"
EOF
chmod 0755 "$launcher_tmp"
mv -f "$launcher_tmp" "$launcher"
launcher_tmp=""
# The Rust launcher is live: the takeover stands — the displaced TS tree
# stays in its legacy slot (with the printed rollback commands) and the
# preserved command file stays in its aside slot.
displaced_ts_root=""
preserved_launcher=""
migrated_old_layout=""

# Retire the launcher's own pre-takeover name (marker-checked: only ever
# remove the shim this script wrote, never a user's file).
old_launcher="${bin_dir}/prime-agent-rust"
if [ -f "$old_launcher" ] && grep -q 'launcher written by install-rust.sh' "$old_launcher" 2>/dev/null; then
  rm -f "$old_launcher"
  echo "removed the old ${old_launcher} launcher (the keyword is prime-agent now)"
fi

# --- the TypeScript takeover completes AFTER the publish ----------------------
# The TS-side steps that RETIRE the old command — the clean idle-daemon stop
# and the npm uninstall — run only once this install has published its
# payload and launcher: a failed install (a refused share dir, a live lock,
# a failed swap) must never leave the machine without a working prime-agent.
# The TS native tree's move to the legacy name cannot be deferred (it
# occupies this installer's publish path); it runs inside the lock with its
# own restore-on-failure and printed rollback instead.
stop_ts_daemon "$ts_socket"
stop_ts_daemon "$rust_socket"

# The TS npm package: uninstalled (operator directive — the Rust port owns the
# keyword), with the restore command printed. Exact package `prime-agent`
# only; best-effort — an npm failure warns and moves on.
if command -v npm >/dev/null 2>&1; then
  npm_root="$(npm root -g 2>/dev/null || true)"
  if [ -n "$npm_root" ] && [ -f "${npm_root}/prime-agent/package.json" ]; then
    ts_version="$(python3 -c 'import json, sys
try:
    package = json.load(open(sys.argv[1]))
    if package.get("name") == "prime-agent":
        print(package.get("version", ""))
except Exception:
    print("")' "${npm_root}/prime-agent/package.json")"
    if [ -n "$ts_version" ]; then
      if npm uninstall -g prime-agent >/dev/null 2>&1; then
        echo "the TypeScript npm package prime-agent@${ts_version} was uninstalled"
        echo "  restore with: npm install -g prime-agent@${ts_version}"
      else
        echo "warning: npm uninstall -g prime-agent failed; run it by hand — the"
        echo "  npm-installed TS command can shadow ${launcher} on PATH"
      fi
    fi
  fi
fi

# --- the kernel pre-warm: uv + the Python kernel venv ------------------------
# The payload ships the prime-agent-runtime/ sidecar but NOT uv and not the
# venv: without this step the FIRST session fails with "uv is required to
# set up the Python kernel" — and the Python kernel is the product's only
# tool, so a fresh install would be dead in the water. The binary's own
# install-time entry (`--prime-agent-bootstrap`, the TS cli-main.ts
# precedent) creates the venv now; both steps are best-effort — an offline
# machine still gets a successful install, and the first session retries
# the bootstrap online per the product's own guidance.
if command -v uv >/dev/null 2>&1 || [ -x "${HOME}/.local/bin/uv" ]; then
  echo "uv found (the kernel venv's package manager)"
else
  echo "installing uv (the kernel venv's package manager — the command the"
  echo "product's own error message names):"
  # The fetch and the script run are checked SEPARATELY: a plain
  # `curl | sh` pipeline reports the SCRIPT's status, so a dead network
  # (curl fails, sh reads nothing and exits 0) would masquerade as success.
  if curl_out="$(curl -LsSf https://astral.sh/uv/install.sh)" \
     && printf '%s\n' "$curl_out" | sh; then
    [ -x "${HOME}/.local/bin/uv" ] \
      || echo "warning: the uv installer reported success but ${HOME}/.local/bin/uv is missing; the first session may need to install uv itself"
  else
    echo "warning: could not install uv (offline?); the kernel pre-warm was"
    echo "  skipped. The first session needs uv — install it with:"
    echo "  curl -LsSf https://astral.sh/uv/install.sh | sh"
  fi
fi
if command -v uv >/dev/null 2>&1 || [ -x "${HOME}/.local/bin/uv" ]; then
  if bootstrap_out="$("$launcher" --prime-agent-bootstrap 2>&1)"; then
    echo "kernel pre-warmed: the first session's Python kernel is ready"
    printf '  %s\n' "$bootstrap_out"
  else
    echo "warning: the kernel pre-warm failed (the install stands; the first"
    echo "  session will retry it online):"
    printf '%s\n' "$bootstrap_out"
  fi
else
  echo "note: kernel pre-warm skipped (no uv); the first session bootstraps"
  echo "  the kernel itself and needs the network once"
fi

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
if [ -d "$old" ]; then
  echo "rollback:  ${old} (the previous payload, one generation; swept on the next install)"
fi
echo "source:    ${WORKFLOW} run ${RUN} (commit ${commit:-unknown})"

echo "next steps: docs/RUST_QUICKSTART.md ships inside the payload"
echo "  ${share_dir}/docs/RUST_QUICKSTART.md"

rm -rf "$dl"
