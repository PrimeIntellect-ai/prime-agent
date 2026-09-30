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
# SOURCE: the R2-backed release channel (this repo file is the source the
# release workflow uploads to the bucket as install.sh / install-beta.sh;
# the channel pointers and manifests it reads - latest.json / beta.json,
# the tarballs, SHA256SUMS - all come from the same download base). The
# workflow-artifact bootstrap channel is retired; the user path never
# touches GitHub.
#
# THE TYPESCRIPT TAKEOVER (this script is also the uninstall path for the
# TS product — one installer owns the keyword's lifecycle):
#   1. BOTH DAEMONS ARE STOPPED CLEANLY, NEVER KILLED, but only AFTER the
#      new payload and launcher are published — the retirement steps
#      (daemon stops, npm uninstall) never leave the machine without a
#      working prime-agent if the install aborts mid-way. The probed
#      candidates: the TS daemon's default socket
#      (${TMPDIR:-/tmp}/prime-agent-$(id -u)/daemon.sock),
#      PRIME_AGENT_DAEMON_SOCKET when a profile exported it (the
#      non-default socket the first field install had), and this
#      product's own pinned rust socket. The daemon that answers a
#      candidate is classified by IDENTITY first — a hello whose
#      runtime build id is this product's ("pa-daemon-rs-<version>",
#      carried since the port) is OUR daemon of any build (the update
#      flow: the running daemon holds the old binary and venv state, the
#      update needs it down, the next invocation boots the new daemon —
#      the summary's next-step line says so) — then by the protocol-7
#      SCHEMA FAMILY: the family prefix minus this product's own hash is
#      the TypeScript daemon of ANY version (the second field install
#      answered schema-30-f908f493c9e1 where the last-known id was
#      schema-29-a5c9d20f8b13; an exact-hash check left it running); the
#      pinned rust socket is ours by construction, no classification at
#      all (an installer older than the daemon build must still stop
#      it). THE SELF-SOCKET REFUSAL: a candidate that equals the daemon
#      DRIVING this very install (the internal supervisor-socket
#      variable a daemon exports to its workers) is never probed at all
#      — the suite that killed the fleet daemon twice ran exactly that
#      shape — unless PRIME_AGENT_STOP_LIVE_DAEMON=1 overrides for a
#      deliberate in-daemon update; an operator shell never carries the
#      internal variable, so the field contract is unchanged. Every
#      daemon so identified is shut down REGARDLESS of busy-ness (the
#      field ruling: an install that leaves the old daemon up is the
#      takeover bug), by an ESCALATING ladder that never sends a signal
#      to any pid: the graceful `shutdown` request (force:false), a 5s
#      confirm poll, then the forced request (force:true) and a
#      DRAIN-SCALED second poll (2s per reported session over a 5s
#      floor — the field measured a 46-worker drain at ~49s, and a fixed
#      5s poll reported the dying daemon as a stop-failure) — every
#      request is the daemon's own shutdown over its socket, and the
#      sessions' state stays on disk for the Rust side. The install then
#      VERIFIES every stopped socket is down (the socket stops
#      answering) and reports what was stopped in the summary; a daemon
#      that would not go down — or answers an unrecognized schema, or
#      will not greet — is a LOUD warning naming it and the manual stop
#      command (never a silent nothing-was-done), and a machine with no
#      daemon anywhere says so (every candidate is reported — no silent
#      skips). An unreadable session count never skips the stop.
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
#   3. WHY DAEMON CONFLICTS ARE GONE AFTER THIS INSTALL: the launcher
#      pins a rust-only daemon socket
#      (${TMPDIR:-/tmp}/prime-agent-rust-$(id -u)/daemon.sock) — a
#      different path than the TS daemon's own — so BY DEFAULT this CLI
#      and the TS daemon never meet (each product's default socket is its
#      own), and the install-time stop-when-idle above retires a TS daemon
#      cleanly instead of orphaning one. Explicit overrides can still point
#      anywhere (--daemon-socket > PRIME_AGENT_DAEMON_SOCKET > the pinned
#      default — the product's documented contract; a foreign-schema daemon
#      behind an override reads as stale, the same behavior in both
#      products). Default pin + clean stop: out of the box, the two
#      daemons cannot fight over a socket after install.
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
# Config (env with defaults):
#   PRIME_AGENT_DOWNLOAD_BASE_URL  the R2-backed download base (default:
#                                  the official domain, the same base the
#                                  release pipeline renders into the
#                                  published copy of this script)
#   PRIME_AGENT_RELEASE_CHANNEL   stable | beta (default: stable)
#   PRIME_AGENT_VERSION           pin an exact version instead of reading
#                                  the channel pointer
#   PRIME_AGENT_RUST_PREFIX       install prefix (default: ~/.local; the
#                                  launcher lands at $PREFIX/bin/prime-agent,
#                                  the payload at $PREFIX/share/prime-agent/)
#
# THE CHANNEL (the R2 form, the TS install.sh parity): the script reads
# the channel pointer (<base>/stable or <base>/beta) for the version,
# reads the channel manifest (<base>/latest.json or <base>/beta.json) for
# this platform's artifact row, fetches the tarball + SHA256SUMS from
# <base>/releases/v<version>/, and verifies the checksum before
# extraction. NO GITHUB SURFACE anywhere in the user path: no gh, no
# GITHUB_TOKEN, no workflow-artifact API — the download base is the
# R2-backed domain, and everything the installer reads comes from it.
#
# Usage: install-rust.sh [--update] — both entry points install the
# channel's current version; the script is idempotent (a re-run replaces
# the payload, keeps one .old rollback generation, and re-runs the
# takeover steps as no-ops when there is nothing left to take over).
#
# PREREQUISITES: curl + sh (+ the network for the download). The installer
# needs a Python for its own scripting steps (the store guard's realpath,
# the channel manifest's JSON parsing, the daemon probe) — but it does
# NOT need one installed: it bootstraps uv first (a static binary whose
# installer needs only curl + sh) and resolves its Python THROUGH uv (an
# existing interpreter when there is one, else uv's own managed 3.11 —
# no system python3 anywhere). Offline without uv, a system python3 is
# the fallback; with neither, the installer names the one missing
# prerequisite and exits.
set -eu

# The publish-rendered defaults: the release pipeline copies this script
# to <base>/install.sh with DOWNLOAD_BASE_URL_DEFAULT set to
# vars.R2_PUBLIC_BASE_URL, and to <base>/install-beta.sh with the channel
# default set to beta — the repo-file default IS the official domain, so
# the raw repo copy installs out of the box too.
DOWNLOAD_BASE_URL_DEFAULT="https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev"
RELEASE_CHANNEL_DEFAULT="stable"
BASE_URL="${PRIME_AGENT_DOWNLOAD_BASE_URL:-$DOWNLOAD_BASE_URL_DEFAULT}"
CHANNEL="${PRIME_AGENT_RELEASE_CHANNEL:-$RELEASE_CHANNEL_DEFAULT}"
PREFIX="${PRIME_AGENT_RUST_PREFIX:-$HOME/.local}"

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

Needs curl + sh (+ the network): the installer bootstraps its own Python via
uv — no system python3 required. It also pre-warms the Python kernel (uv +
`prime-agent --prime-agent-bootstrap`); offline, that step degrades to a
warning and the first session bootstraps the kernel itself — it needs the
network once.

Options:
  --update    the documented alias the update entry points exec (identical run)
  --verbose   the progress detail also goes to stdout, not just fd 3
Output:
  stdout      the essentials (the success block, the actionable takeover
              facts, the PATH warning when it applies, the next-step line)
  fd 3        the progress detail — a wrapper captures it by opening fd 3;
              a bare run leaves it closed and stays quiet
  stderr      warnings and diagnostics (a curl | sh run keeps them)

Environment:
  PRIME_AGENT_DOWNLOAD_BASE_URL  the R2-backed download base (the official
                                 domain by default)
  PRIME_AGENT_RELEASE_CHANNEL    stable | beta (stable by default)
  PRIME_AGENT_VERSION            pin an exact version (skips the channel
                                 pointer read; the manifest + SHA256SUMS
                                 checks still run)
  PRIME_AGENT_RUST_PREFIX        install prefix (~/.local by default)
  PRIME_AGENT_RUST_VERBOSE       1 = the --verbose output mode
USAGE
}

# --- arguments ---------------------------------------------------------------
# No positional arguments. --update is the documented alias the update entry
# points (`prime-agent update`, the TUI /update) exec — identical to the default
# run because the flow is idempotent by construction. --verbose folds the fd-3
# progress detail onto stdout (PRIME_AGENT_RUST_VERBOSE=1 does the same).
VERBOSE="${PRIME_AGENT_RUST_VERBOSE:-0}"
# Every argument is scanned (no positionals exist): the flags compose, so
# `--update --verbose` sets both effects instead of silently dropping one.
for arg in "$@"; do
  case "$arg" in
    --update) ;;
    --verbose|-v) VERBOSE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: ${arg}" ;;
  esac
done

# --- the output contract ------------------------------------------------------
# Minimal by default (the curl|sh reference class): stdout carries the
# essentials only — the success block, the actionable takeover facts, the
# conditional PATH warning, the next-step line — which is exactly what a
# wrapper like `prime-agent update` reports onward. Progress detail rides
# fd 3: a wrapper opens it to capture the trace, a bare run leaves it
# closed (the detail drops silently), and --verbose folds it onto stdout.
# Warnings and diagnostics go to stderr, which a `curl | sh` run keeps.
if [ "$VERBOSE" = 1 ]; then
  exec 3>&1
elif ( : >&3 ) 2>/dev/null; then
  :   # already open — a wrapper's capture channel; keep it (the subshell
      # probe tests the DESCRIPTOR, not a /dev/fd node: on macOS /dev/fd/3
      # exists while fd 3 is closed, and a redirect onto a closed fd under
      # set -e would abort the installer at its first progress line)
else
  exec 3>/dev/null
fi
say() { printf '%s\n' "$*" >&3; }
note() { printf '%s\n' "$*" >&2; }

# --- the Python bootstrap: the installer must not depend on system python3 ----
# Every scripting step below (the store guard's realpath, the artifact's
# JSON parsing and zip extraction, the daemon probe) needs a Python — and a
# fresh machine may have none. The fix is uv first: a single static binary
# whose installer needs only curl + sh, and uv can then provide the Python
# itself (its own standalone builds — no system python anywhere).
#
# NOTE ON THE GUARD ORDER BELOW: the astral installer writes only its own
# fixed install path (~/.local/bin/uv), never under this installer's
# prefix — so the store guard still runs before the FIRST PREFIX-DERIVED
# write, which is the invariant that matters. THE STORE-ALIAS FALLBACK:
# ~/.local/bin can still resolve INSIDE the shared session store (the
# alias shape: a user symlinked ~/.local into ~/.prime/agent), which
# would put the astral installer's write under the store before the
# guard runs — so when the default target resolves there, uv goes to
# THIS install's prefix bin dir instead (the payload-adjacent fallback)
# and the store is never written. (uv's install otherwise lands on PATH
# at ~/.local/bin, the same default prefix this script uses; a custom
# prefix simply keeps uv at ~/.local, where the product's own ensure_uv
# also looks for it.)
# The physical-path probe is POSIX-only (cd + pwd -P): readlink -f is
# coreutils, and macOS ships without it. A DANGLING target (a uv target
# directory that does not exist yet - the normal shape at install time)
# must still resolve through its nearest EXISTING ancestor: the old
# single-level probe returned the unresolved spelling, and a parent
# symlink into the shared store would slip the containment check (the
# bots' finding) - the uv binary would then be created THROUGH the
# symlink, inside the store. The parent/base split rides parameter
# expansion alone (no dirname/basename: the bare-machine PATH of the
# installer's own support matrix carries neither).
physical_path() {
  # Trailing slashes normalize first (a PREFIX spelled with one must not
  # abort the ancestor walk): "/x/" resolves like "/x", never as an
  # empty-basename dead end.
  phys_input="$1"
  while [ "$phys_input" != "/" ] && [ "$phys_input" != "${phys_input%/}" ]; do
    phys_input="${phys_input%/}"
  done
  case "$phys_input" in
    */*) phys_parent="${phys_input%/*}" phys_base="${phys_input##*/}" ;;
    *)   phys_parent="." phys_base="$phys_input" ;;
  esac
  if [ -d "$phys_input" ]; then
    ( cd "$phys_input" 2>/dev/null && pwd -P ) || printf '%s' "$phys_input"
  elif [ -z "$phys_base" ] || [ "$phys_parent" = "$phys_input" ]; then
    printf '%s' "$phys_input"
  else
    printf '%s/%s' "$(physical_path "$phys_parent")" "$phys_base"
  fi
}
uv_store_root="$(physical_path "${HOME}/.prime/agent")"
uv_default_root="$(physical_path "${HOME}/.local")"
uv_bin_dir="${HOME}/.local/bin"
uv_under_store="no"
case "${uv_default_root}/" in
  "${uv_store_root}/"*) uv_under_store="yes" ;;
esac
if [ "$uv_under_store" = "yes" ]; then
  uv_bin_dir="${PREFIX}/bin"
  say "uv target: ${HOME}/.local resolves inside the shared session store;"
  say "  uv installs payload-adjacent at ${uv_bin_dir} instead"
fi
# THE FALLBACK'S OWN GUARD (the store guard cannot cover this write: the
# astral install runs BEFORE the guard does): the computed target must
# itself resolve OUTSIDE the shared store. The default prefix under the
# alias shape IS the store (~/.local is the alias), and a
# PRIME_AGENT_RUST_PREFIX pointing into the store (refused by the guard
# only later) must not become the uv target either. With no safe target,
# uv is NOT installed from here — a skipped uv beats a write under the
# shared store; the system-python fallback carries the install, and a
# machine with neither is the die path that names uv.
uv_target_root="$(physical_path "${uv_bin_dir}")"
uv_target_unsafe="no"
case "${uv_target_root}/" in
  "${uv_store_root}/"*) uv_target_unsafe="yes" ;;
esac
if [ "$uv_target_unsafe" = "yes" ]; then
  note "warning: the uv target ${uv_bin_dir} resolves inside the shared session"
  note "  store (a PRIME_AGENT_RUST_PREFIX pointing into the store, or the"
  note "  default prefix under the ~/.local alias); uv is NOT installed from"
  note "  here — the store is never written by this installer"
  uv_bin_dir=""
fi
uv_bin=""
if command -v uv >/dev/null 2>&1; then
  uv_bin="$(command -v uv)"
elif [ -x "${uv_bin_dir}/uv" ]; then
  uv_bin="${uv_bin_dir}/uv"
else
  # The fetch and the script run are checked SEPARATELY: a plain
  # `curl | sh` pipeline reports the script's status, so a dead network
  # would masquerade as success. The astral installer honors two
  # destination-redirecting env vars (UV_INSTALL_DIR, UV_UNMANAGED_INSTALL):
  # the computed target is passed EXPLICITLY — the default path
  # (~/.local/bin) in the normal case, the prefix bin dir under the store
  # alias — which also overrides any inherited value pointing into the
  # shared session store (it would place uv there BEFORE the store guard
  # runs).
  if [ -n "$uv_bin_dir" ] \
     && uv_install_out="$(curl -fsSLsS https://astral.sh/uv/install.sh)" \
     && printf '%s\n' "$uv_install_out" \
        | env -u UV_UNMANAGED_INSTALL UV_INSTALL_DIR="$uv_bin_dir" sh >/dev/null 2>&1 \
     && [ -x "${uv_bin_dir}/uv" ]; then
    uv_bin="${uv_bin_dir}/uv"
  fi
fi

# Resolve the installer's Python, once. DETERMINISTIC CHOICE (recorded in
# the log line below): prefer an interpreter uv already sees
# (`uv python find 3.11` — the system python3 counts when it exists), and
# only otherwise install uv's own managed 3.11. Offline with no usable uv,
# fall back to a system python3; with neither, the machine is missing the
# one prerequisite the installer cannot provide for itself.
UVPY=""
if [ -n "$uv_bin" ]; then
  # --system is load-bearing twice over: without it `uv python find`
  # honors the CURRENT DIRECTORY's project pin (a pyproject.toml or
  # .python-version demanding a newer Python can shadow the exact 3.11
  # this bootstrap just installed) and its venv discovery can hand back
  # a checkout's .venv interpreter — code this installer would then
  # EXECUTE with the downloaded artifact's bytes as input, before any
  # validation. The flag restricts the resolution to system-level
  # interpreters (uv's own managed installs count).
  # UV_PYTHON_INSTALL_DIR is cleared on EVERY uv call in this
  # resolution (find and install both): uv uses it as the single
  # managed-Python directory for discovery AS WELL AS installation, so
  # an inherited value would make the find look only in a custom root
  # while the install (cleared) lands in the default one — the
  # just-installed interpreter would never be found.
  UVPY="$(env -u UV_PYTHON_INSTALL_DIR "$uv_bin" python find --system 3.11 2>/dev/null || true)"
  if [ -z "$UVPY" ]; then
    if env -u UV_PYTHON_INSTALL_DIR "$uv_bin" python install 3.11 >/dev/null 2>&1; then
      UVPY="$(env -u UV_PYTHON_INSTALL_DIR "$uv_bin" python find --system 3.11 2>/dev/null || true)"
    fi
  fi
fi
if [ -z "$UVPY" ] && command -v python3 >/dev/null 2>&1; then
  UVPY="python3"
fi
[ -n "$UVPY" ] \
  || die "the installer could not obtain a Python runtime, which it needs
for its scripting steps (the store guard, the artifact handling). Install
uv with:
  curl -LsSf https://astral.sh/uv/install.sh | sh
(the installer then provisions its own Python through uv — no system
python3 required), or install python3 yourself and re-run"

# --- the preserve invariant: guard the shared store ---------------------------
# ~/.prime/agent is shared by both products BY DESIGN (sessions, leases,
# config). No step of this installer may write, rename, or delete under it.
# guard_preserved aborts when a target path resolves under the store —
# the realistic trigger is a mis-set PRIME_AGENT_RUST_PREFIX.
# Resolved like PREFIX below: when $HOME is a symlink, a PREFIX spelled in the
# physical form must still compare equal to the store, or the guard would
# pass two different spellings of the same directory.
PRESERVED_STORE="$("$UVPY" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${HOME}/.prime/agent")"
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
PREFIX="$("$UVPY" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$PREFIX")"
guard_preserved "$PREFIX" "${PREFIX}/share" "${PREFIX}/bin"
mkdir -p "${PREFIX}/share" "${PREFIX}/bin"
# The guard must also see THROUGH symlinked child roots: a ${PREFIX}/share or
# ${PREFIX}/bin that is a symlink into the shared store would otherwise let
# the publish write under it while every lexical check passes. Resolving the
# children (not refusing them) keeps legitimate out-of-store symlinked roots
# installable while the resolved paths go through the same guard.
for install_root in "${PREFIX}/share" "${PREFIX}/bin"; do
  guard_preserved "$("$UVPY" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$install_root")"
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
# CHANNEL_PLATFORM is the channel manifest's platform alias (the TS
# NATIVE_PLATFORMS spelling pa-core::update::install::current_platform_alias
# reads); TARGET stays the rust triple the payload names its targets by.
case "$OS:$ARCH" in
  Darwin:arm64) TARGET=aarch64-apple-darwin; CHANNEL_PLATFORM=darwin-arm64 ;;
  Darwin:x86_64) TARGET=x86_64-apple-darwin; CHANNEL_PLATFORM=darwin-x64 ;;
  Linux:x86_64) TARGET=x86_64-unknown-linux-gnu; CHANNEL_PLATFORM=linux-x64 ;;
  Linux:aarch64) TARGET=aarch64-unknown-linux-gnu; CHANNEL_PLATFORM=linux-arm64 ;;
  *)
    die "no rust build is published for ${OS} ${ARCH} (detected via uname);
the release channel builds aarch64-apple-darwin, x86_64-apple-darwin,
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
  say "glibc ${glibc} >= 2.35: supported"
fi

# --- the R2 channel (the user path never touches GitHub) --------------------
# THE CHANNEL RESOLUTION (the TS install.sh parity): the channel pointer
# file gives the version, the channel manifest gives this platform's
# artifact row, and the versioned release prefix serves the tarball +
# SHA256SUMS. No gh, no GITHUB_TOKEN, no workflow-artifact API — the
# download base is the R2-backed domain and everything comes from it.
case "$CHANNEL" in
  stable) CHANNEL_MANIFEST="latest.json" ;;
  beta) CHANNEL_MANIFEST="beta.json" ;;
  *) die "unknown release channel: ${CHANNEL} (stable or beta)" ;;
esac
case "$BASE_URL" in
  https://*) ;;
  *) die "the download base URL must be an https URL: ${BASE_URL}" ;;
esac
BASE_URL="${BASE_URL%/}"

VERSION_PINNED="no"
if [ -n "${PRIME_AGENT_VERSION:-}" ]; then
  VERSION="${PRIME_AGENT_VERSION#v}"
  VERSION_PINNED="yes"
else
  # THE RETRY (the publish's consistency window): the channel pointers
  # flip one after the other (the manifest, then the version pointer), so
  # a read landing between them sees the old pointer with the new
  # manifest — a transient mismatch, not a broken channel. One re-read of
  # the PAIR resolves it; a second refusal is a real error.
  version_attempt=1
  while :; do
    VERSION="$(curl -fsSL "${BASE_URL}/${CHANNEL}" 2>/dev/null || true)"
    [ -n "$VERSION" ] && break
    version_attempt=$((version_attempt + 1))
    [ "$version_attempt" -le 2 ] || break
    sleep 1
  done
fi
case "$VERSION" in
  ""|v)
    die "could not resolve the latest ${CHANNEL} version from ${BASE_URL}/${CHANNEL}
(set PRIME_AGENT_VERSION to pin an exact version, or check the network)"
    ;;
  *[!0-9A-Za-z.-]*)
    die "invalid version from the ${CHANNEL} channel pointer: ${VERSION}"
    ;;
esac
say "installing prime-agent ${VERSION} from the ${CHANNEL} channel (${CHANNEL_PLATFORM})"

# --- the channel manifest: this platform's artifact row ---------------------
# The manifest carries the version plus the per-platform rows; the row's
# file must be the exact channel naming and its sha256 the 64-hex shape —
# the same validation pa-core::update::release::latest_release applies, so
# a lying manifest refuses here instead of staging a wrong tarball.
# A PINNED version (PRIME_AGENT_VERSION) skips the channel manifest
# entirely — the channel manifest describes the channel's CURRENT
# release, and a historical pin must install from its own versioned
# prefix (the release's SHA256SUMS carries the row's digest; the
# channel-naming contract gives the file name).
# The row reader rides a FILE, not a heredoc inside a command substitution
# (the probe-py pattern: macOS ships bash 3.2 as /bin/sh, and its
# POSIX-mode parser cannot close a $( ) that spans a heredoc body).
dl="$(mktemp -d "${TMPDIR:-/tmp}/prime-agent-download.XXXXXX")"
if [ "$VERSION_PINNED" = "yes" ]; then
  asset_name="prime-agent-${VERSION}-${CHANNEL_PLATFORM}.tar.gz"
  manifest_sha=""
else
manifest_attempt=1
while :; do
  curl -fsSL "${BASE_URL}/${CHANNEL_MANIFEST}" -o "$dl/${CHANNEL_MANIFEST}" \
    || die "could not read the ${CHANNEL} channel manifest: ${BASE_URL}/${CHANNEL_MANIFEST}"
  row_py="$dl/channel_row.py"
  cat > "$row_py" <<'ROW_PY'
import json, sys
manifest_path, version, platform = sys.argv[1], sys.argv[2], sys.argv[3]
manifest = json.load(open(manifest_path))
manifest_version = manifest.get("version", "")
if manifest_version.lstrip("v") != version.lstrip("v"):
    sys.exit(f"manifest version {manifest_version} != channel version {version}")
rows = manifest.get("binaries_v2") or manifest.get("binaries") or []
expected = f"prime-agent-{version.lstrip('v')}-{platform}.tar.gz"
for row in rows:
    if row.get("platform") != platform:
        continue
    if row.get("file") != expected:
        sys.exit(f"artifact row file {row.get('file')} != the channel naming {expected}")
    print(json.dumps({"file": row["file"], "sha256": row.get("sha256", "")}))
    break
else:
    sys.exit(f"no artifact row for platform {platform} in the channel manifest")
ROW_PY
  row_json="$("$UVPY" "$row_py" "$dl/${CHANNEL_MANIFEST}" "$VERSION" "$CHANNEL_PLATFORM")" \
    || { manifest_err="$("$UVPY" "$row_py" "$dl/${CHANNEL_MANIFEST}" "$VERSION" "$CHANNEL_PLATFORM" 2>&1 | head -n 1)"
         manifest_attempt=$((manifest_attempt + 1))
         if [ "$manifest_attempt" -le 2 ] && printf '%s' "$manifest_err" | grep -q '!= channel version'; then
           # THE CONSISTENCY-WINDOW RETRY: the manifest flipped before the
           # pointer (the publish writes the manifest first) — re-read the
           # PAIR once before refusing.
           sleep 1
           VERSION="$(curl -fsSL "${BASE_URL}/${CHANNEL}" 2>/dev/null || true)"
           [ -n "$VERSION" ] || die "could not resolve the latest ${CHANNEL} version from ${BASE_URL}/${CHANNEL}"
           say "installing prime-agent ${VERSION} from the ${CHANNEL} channel (${CHANNEL_PLATFORM})"
           continue
         fi
         die "the ${CHANNEL} channel manifest is not usable: ${BASE_URL}/${CHANNEL_MANIFEST} (${manifest_err})"; }
  asset_name="$(printf '%s' "$row_json" | "$UVPY" -c 'import json,sys; print(json.load(sys.stdin)["file"])')"
  manifest_sha="$(printf '%s' "$row_json" | "$UVPY" -c 'import json,sys; print(json.load(sys.stdin)["sha256"])')"
  case "$manifest_sha" in
    ""|?|??|*[!0-9a-f]*) die "the channel manifest's sha256 for ${asset_name} is malformed" ;;
  esac
  break
done
fi

# --- the tarball + SHA256SUMS from the versioned release prefix -------------
RELEASE_PREFIX="releases/v${VERSION#v}"
curl -fsSL "${BASE_URL}/${RELEASE_PREFIX}/${asset_name}" -o "$dl/${asset_name}" \
  || die "could not download ${asset_name} from ${BASE_URL}/${RELEASE_PREFIX}/"
curl -fsSL "${BASE_URL}/${RELEASE_PREFIX}/SHA256SUMS" -o "$dl/SHA256SUMS" \
  || die "could not download SHA256SUMS from ${BASE_URL}/${RELEASE_PREFIX}/"
asset="$dl/${asset_name}"

# --- verify the checksum -------------------------------------------------------
# The release prefix's SHA256SUMS covers the tarball; the verification
# happens before extraction, so a truncated or tampered download refuses
# to install. The channel manifest's row sha256 is cross-checked against
# the SHA256SUMS line first — two independent reads of the same digest
# from the same release prefix — so a lying manifest refuses as loudly as
# a corrupt tarball. (The checksum rides the same channel as the tarball —
# the known same-channel limitation; the signed-asset design is the
# graduation path in RELEASE_SECURITY.md.)
line="$(grep "  ${asset_name}\$" "$dl/SHA256SUMS" || true)"
[ -n "$line" ] || die "SHA256SUMS in ${RELEASE_PREFIX} has no line for ${asset_name}"
sums_sha="${line%% *}"
if [ -n "$manifest_sha" ]; then
  [ "$sums_sha" = "$manifest_sha" ] \
    || die "checksum mismatch between the channel manifest and SHA256SUMS for ${asset_name}: the channel is inconsistent; re-run the installer"
fi
printf '%s\n' "$line" > "$dl/SHA256SUMS.check"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$dl" && sha256sum -c SHA256SUMS.check 2>&1 >&3) 1>&3 \
    || die "checksum mismatch for ${asset_name}: the download is corrupt; re-run the installer"
elif command -v shasum >/dev/null 2>&1; then
  (cd "$dl" && shasum -a 256 -c SHA256SUMS.check 2>&1 >&3) 1>&3 \
    || die "checksum mismatch for ${asset_name}: the download is corrupt; re-run the installer"
else
  die "no sha256 tool found (sha256sum or shasum is required to verify the download)"
fi
say "checksum verified: ${asset_name} (${VERSION}, the ${CHANNEL} channel)"

# --- the TypeScript takeover, step 1: stop BOTH daemons ALWAYS ----------------
# THE ALWAYS-STOP CONTRACT (PR1's field ruling, hardened + the second
# field install's evidence): the TS daemon is shut down REGARDLESS of
# busy-ness — the Rust daemon owns the store after this install, and the
# TS sessions' state is on disk for the Rust side to resume what the
# user resumes — and THIS PRODUCT'S OWN daemon is stopped too (the
# operator's update ruling: a running rust daemon holds the old binary
# and venv state; the update needs it down, and the next invocation
# boots the new daemon — the summary's next-step line says so).
# The stop is ESCALATING but still clean: the graceful `shutdown`
# request first (force:false — the daemon's own stop path), a confirm
# poll, then a forced `shutdown` request (force:true) if the graceful
# one did not settle, and a second confirm poll. NOTHING IS EVER KILLED
# from here: no signal is sent to any pid at any step — even the forced
# request is the daemon's own shutdown request over its socket. An
# unreadable session count never skips the stop (the ladder runs with
# the count unknown).
# THE CLASSIFICATION (the second field install's evidence: the friend's
# TS daemon answered schema protocol-7-schema-30-f908f493c9e1 where the
# installer expected protocol-7-schema-29-a5c9d20f8b13 — the exact-hash
# check classified it as foreign and the install stopped nothing): the
# TS daemon is the protocol-7 SCHEMA FAMILY minus this product's own
# hash — the family match catches every TS version. The pinned rust
# socket is OUR daemon by construction (no schema inspection; the
# pinned path is the identity). A daemon that answers neither shape, or
# will not greet, is NEVER silently skipped: the LOUD warning names it
# and the manual stop command.
# THE CANDIDATES (no silent skips): the TS daemon's default socket,
# PRIME_AGENT_DAEMON_SOCKET when a profile exported it, and this
# product's pinned rust socket. Every outcome is REPORTED (a say/note
# line, plus a summary line for the stops) — a daemon that would not go
# down is a LOUD warning, and the install ALWAYS verifies every stopped
# socket is DOWN before the summary prints (a --listening re-check; the
# socket stops answering).
# ts_stop_summary accumulates the summary line(s); the success block
# prints them with the other takeover facts.
ts_stop_summary=""
ts_stop_found_any=""
ts_stop_refused=""
ts_stop_rust_stopped=""
ts_socket="${TMPDIR:-/tmp}/prime-agent-$(id -u)/daemon.sock"
rust_socket="${TMPDIR:-/tmp}/prime-agent-rust-$(id -u)/daemon.sock"
env_socket="${PRIME_AGENT_DAEMON_SOCKET:-}"
# THE TILDE EXPANSION (the CLI's own spelling: the products' clients
# expand a leading ~/ in PRIME_AGENT_DAEMON_SOCKET before connecting, so
# a profile exporting "~/..." names the real socket; a literal tilde path
# would read as absent here and the daemon would be left running through
# the update).
case "$env_socket" in
  "~/"*) env_socket="${HOME}${env_socket#\~}" ;;
esac
# THE SELF-SOCKET REFUSAL (the fleet-kill class, twice in the field: an
# installer run UNDER a daemon probed that daemon's own socket through
# the inherited PRIME_AGENT_DAEMON_SOCKET and stopped it — the running
# agent died with its supervisor): the daemon driving THIS process tree
# is identified by the internal supervisor-socket variable it exports to
# its workers (TS parity), with the worker-role marker + the public
# socket as the belt. A stop candidate equal to it is NEVER probed at
# all — not even the hello — unless PRIME_AGENT_STOP_LIVE_DAEMON=1
# explicitly overrides for a deliberate in-daemon update. An operator
# shell never carries the internal variables (a profile-exported
# PRIME_AGENT_DAEMON_SOCKET alone does not trigger the refusal), so the
# field contract is unchanged.
live_daemon_socket="${PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET:-}"
if [ -z "$live_daemon_socket" ] && [ "${PRIME_AGENT_INTERNAL_DAEMON_WORKER:-}" = "1" ]; then
  live_daemon_socket="${PRIME_AGENT_DAEMON_SOCKET:-}"
fi
case "$live_daemon_socket" in
  "~/"*) live_daemon_socket="${HOME}${live_daemon_socket#\~}" ;;
esac
# THE CANDIDATES ride named variables, never a space-joined list (the
# bots' finding): a socket path containing whitespace would word-split
# into phantom candidates (and an unquoted iteration would glob too), so
# the probe list is the three named paths probed in order — the TS
# default socket, a profile-exported env socket, this product's pinned
# rust socket — deduped by string equality, each probed exactly once.
# ts_candidate_report names every candidate for the no-silent-skips
# ruling (a report string may carry the spaces; the probes do not).
ts_candidate_report="$ts_socket"
env_socket_probe="no"
if [ -n "$env_socket" ] && [ "$env_socket" != "$ts_socket" ] && [ "$env_socket" != "$rust_socket" ]; then
  env_socket_probe="yes"
  ts_candidate_report="$ts_candidate_report, $env_socket"
fi
# The pin is probed as OURS whenever it is not the TS default; an env
# export pointing AT the pin is the same socket (one probe, as ours).
rust_socket_probe="no"
if [ "$rust_socket" != "$ts_socket" ]; then
  rust_socket_probe="yes"
  ts_candidate_report="$ts_candidate_report, $rust_socket"
fi
# The daemon probe rides a FILE, not a heredoc inside a command
# substitution: macOS ships bash 3.2 as /bin/sh, and its POSIX-mode parser
# cannot close a $( ) that spans a heredoc body ("unexpected EOF while
# looking for matching ')'" — the operator hit it live on darwin-arm64 at
# exactly this construct. A top-level heredoc writes the probe once (the
# download dir is this run's temp, swept with it); the substitution then
# holds a plain call.
probe_py="${dl}/daemon-stop.py"
cat > "$probe_py" <<'PROBE_PY'
import json, select, socket, sys, time

path = sys.argv[-1]
kind = "ts"
listening_only = False
for flag in sys.argv[1:-1]:
    if flag == "--listening":
        listening_only = True
    if flag.startswith("--kind="):
        kind = flag[len("--kind="):]

# The classification ladder, identity before schema: a hello whose
# runtime build id is this product's ("pa-daemon-rs-<version>", carried by
# every rust build since the port) is OUR daemon of ANY build; below that,
# the two products share the protocol-7 schema FAMILY
# ("protocol-7-schema-<revision>-<hash>"): the TypeScript product's id
# moves with every TS release (the field install answered
# schema-30-f908f493c9e1 where the last-known id was schema-29-a5c9d20f8b13
# — an exact-hash check classified the friend's older TS daemon as foreign
# and the install left it up). The family prefix minus this product's own
# shapes is the TypeScript daemon of ANY version; anything else is
# unrecognized (the loud warning).
TS_SCHEMA_FAMILY = "protocol-7-schema-"
RUST_SCHEMA_ID = "protocol-7-schema-30-8e4b17c2a9f5"
RUST_BUILD_ID_PREFIX = "pa-daemon-rs-"
HELLO_TIMEOUT_S = 1.5
PROBE_TIMEOUT_S = 5.0
STOP_CONFIRM_TIMEOUT_S = 5.0
# The final (post-forced) poll outlasts a healthy drain instead of a fixed
# 5s: the field event measured a 46-worker drain at ~49s while the 5s poll
# declared the dying daemon "still running". The window is CAPPED: the
# scaling serves a healthy drain (2s per session over the 5s floor), and a
# daemon still up after the cap has heard BOTH requests and is not
# draining - the stop-failed verdict + the loud manual-stop warning beat
# blocking an install for hours on a pathological count.
STOP_DRAIN_MINIMUM_S = 5.0
STOP_DRAIN_PER_SESSION_S = 2.0
STOP_DRAIN_UNKNOWN_S = 30.0
STOP_DRAIN_CAP_S = 120.0

def read_line(sock, deadline, buf):
    # One persistent buffer per connection: a daemon that answers
    # immediately can land its hello and the response in one packet, and
    # a line reader that returns only the first line and drops the rest
    # would lose the response.
    while time.monotonic() < deadline:
        if b"\n" in buf:
            line, _, _rest = buf.partition(b"\n")
            del buf[: len(line) + 1]
            return line.decode("utf-8", "replace")
        if select.select([sock], [], [], 0.05)[0]:
            part = sock.recv(4096)
            if not part:
                return None
            buf.extend(part)
    return None

def connect():
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(HELLO_TIMEOUT_S)
    sock.connect(path)
    return sock

def wait_hello(sock):
    buf = bytearray()
    deadline = time.monotonic() + HELLO_TIMEOUT_S
    while time.monotonic() < deadline:
        line = read_line(sock, deadline, buf)
        if line is None:
            return None
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if value.get("type") == "daemon_hello":
            return value
    return None

def listening_flag():
    try:
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.settimeout(0.25)
        probe.connect(path)
        probe.close()
        return True
    except OSError:
        return False

def stopped_within(timeout_s):
    end = time.monotonic() + timeout_s
    while time.monotonic() < end:
        if not listening_flag():
            return True
        time.sleep(0.05)
    return False

# The listening-only mode: the summary-time verification that a socket a
# stop verdict was recorded for stays down.
if listening_only:
    print("up" if listening_flag() else "down")
    sys.exit(0)

# The request rides the protocol-7 COMMAND ENVELOPE exactly like the
# products' own clients (the supervisor refuses bare commands: "Daemon
# commands require protocol ... or newer" — a bare `list` would kill the
# probe). Each request opens a fresh connection, CONSUMES the daemon's
# hello first (the daemon greets every connection; leaving the hello
# unread parks the line reader on it), then sends the command and reads
# the reply.
def envelope(request_id, body):
    return json.dumps({
        "type": "command",
        "id": request_id,
        "protocol": {"name": "prime-agent.daemon", "version": 7},
        "clientId": "install-rust-sh",
        "command": dict(body, id=request_id),
    }) + "\n"

def classify_hello(value):
    # The classification ladder, factored so every NEW connection
    # re-verifies it (the bots' finding: the probe classifies once and
    # then sends list/shutdown over FRESH connections — a daemon
    # replaced between them would receive commands without ever being
    # classified; the replacement check below aborts the ladder on any
    # owner change).
    runtime = value.get("runtime")
    build_id = runtime.get("buildId") if isinstance(runtime, dict) else None
    schema = value.get("schemaId")
    if isinstance(build_id, str) and build_id.startswith(RUST_BUILD_ID_PREFIX):
        return "rust"
    if schema == RUST_SCHEMA_ID:
        return "rust"
    if isinstance(schema, str) and schema.startswith(TS_SCHEMA_FAMILY):
        return "ts"
    return None

request_replaced = False

def request(body):
    global request_replaced
    request_id = "installer-" + body["type"] + ("-force" if body.get("force") else "")
    try:
        sock = connect()
    except OSError:
        return None
    hello = wait_hello(sock)
    if hello is None:
        sock.close()
        return None
    # A TS-classified candidate re-classifies every connection: the
    # owner that answered the hello must be the owner the ladder
    # classified, or a REPLACEMENT daemon took the socket (an
    # unrecognized one at that — the replacement check refuses to send
    # it any command; never killed blind, never commanded blind).
    if owner == "ts" and classify_hello(hello) != "ts":
        sock.close()
        request_replaced = True
        return None
    sock.sendall(envelope(request_id, body).encode())
    buf = bytearray()
    deadline = time.monotonic() + PROBE_TIMEOUT_S
    while time.monotonic() < deadline:
        line = read_line(sock, deadline, buf)
        if line is None:
            break
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if value.get("type") == "response" and value.get("id") == request_id:
            sock.close()
            return value
    sock.close()
    return None

try:
    sock = connect()
except OSError:
    print("stale")
    sys.exit(0)

hello = wait_hello(sock)
if hello is None:
    print("no-hello")
    sys.exit(0)
schema = hello.get("schemaId")
runtime = hello.get("runtime")
build_id = runtime.get("buildId") if isinstance(runtime, dict) else None
if kind == "ts":
    # The TS candidates classify by IDENTITY first, then by schema: a
    # hello carrying this product's runtime build id is OUR daemon of any
    # build (a user's PRIME_AGENT_DAEMON_SOCKET override pointing at a
    # running Rust daemon — the update flow stops it too, whatever its
    # schema hash; the field's stale rust daemon was twice mislabeled TS
    # by the hash-only guess); below that the family prefix is the
    # TypeScript daemon of any version, this product's own exact hash
    # stays ours, and anything else is unrecognized.
    if isinstance(build_id, str) and build_id.startswith(RUST_BUILD_ID_PREFIX):
        owner = "rust"
    else:
        if not isinstance(schema, str):
            sock.close()
            print("no-schema")
            sys.exit(0)
        if schema == RUST_SCHEMA_ID:
            owner = "rust"
        elif schema.startswith(TS_SCHEMA_FAMILY):
            owner = "ts"
        else:
            sock.close()
            print("unrecognized:" + schema)
            sys.exit(0)
else:
    # --kind=ours: the pinned rust socket is this product's own daemon by
    # construction — whatever answers there is stopped for the update,
    # no schema inspection (an installer older than the daemon build must
    # still stop it: the pinned path is the identity, not the hash).
    owner = "rust"
# The identify connection's job is done; every command opens its own
# connection so a busy daemon never parks the probe on a held socket.
sock.close()

# The daemon's session count, for the report. The count is REPORT-ONLY:
# an unreadable list never skips the stop — the ladder runs with the
# count unknown ("?").
count = None
list_response = request({"type": "list"})
if list_response is not None and list_response.get("success"):
    sessions = (list_response.get("data") or {}).get("sessions")
    if isinstance(sessions, list):
        count = len(sessions)
count_label = "?" if count is None else str(count)
if request_replaced:
    print("%s:replaced:%s" % (owner, count_label))
    sys.exit(0)

# THE ESCALATING LADDER (the always-stop contract, for BOTH daemons —
# still no signal to any pid at any step):
#   1. the graceful shutdown request (force:false) — the clean stop an
#      idle daemon settles on immediately;
#   2. a confirm poll (the socket stops answering within 5s);
#   3. the forced shutdown request (force:true) — the busy daemon's own
#      forced stop (its sessions' resume state stays on disk);
#   4. a second confirm poll scaled to the DRAIN (2s per reported session
#      over a 5s floor, 30s when the count is unreadable) — the field
#      event's 46-worker drain took ~49s, and a fixed 5s poll reported
#      the dying daemon as a stop-failure; still listening after the
#      scaled window -> the verdict that makes the installer warn loudly
#      instead of reporting a stop.
def drain_confirm_timeout_s():
    if count is None:
        return STOP_DRAIN_UNKNOWN_S
    return min(STOP_DRAIN_MINIMUM_S + STOP_DRAIN_PER_SESSION_S * count, STOP_DRAIN_CAP_S)

request({"type": "shutdown", "force": False})
if request_replaced:
    print("%s:replaced:%s" % (owner, count_label))
    sys.exit(0)
if stopped_within(STOP_CONFIRM_TIMEOUT_S):
    print("%s:stopped:%s" % (owner, count_label))
    sys.exit(0)
request({"type": "shutdown", "force": True})
if request_replaced:
    print("%s:replaced:%s" % (owner, count_label))
    sys.exit(0)
if stopped_within(drain_confirm_timeout_s()):
    print("%s:stopped-forced:%s" % (owner, count_label))
    sys.exit(0)
print("%s:stop-failed:%s" % (owner, count_label))

PROBE_PY

# The per-candidate verdict handler: every stop attempt and every skip
# reason is reported (a say/note line now, a summary line for the stops);
# a daemon that would not go down — or one that would not IDENTIFY —
# accumulates into the LOUD warning the success block prints (never a
# silent nothing-was-done).
stop_daemon_candidate() {
  socket_path="$1"
  candidate_kind="$2"
  # The caller reads these after each probe: which candidates recorded a
  # stop (for the post-stop verify, per candidate, never through a path
  # list), and whether the stopped daemon was ours (the update-flow
  # next-step line must stay silent when OUR stopped daemon came back).
  last_stop_recorded="no"
  last_stop_was_rust="no"
  # THE SELF-SOCKET REFUSAL: the candidate that is the daemon DRIVING this
  # very install is never probed — not even the hello — unless the
  # explicit override is set (a deliberate in-daemon update). The refusal
  # is loud and lands in the summary: a skipped live daemon is a fact the
  # operator must see, never a silent skip.
  # The equivalence goes BEYOND the raw string: a socket reached through
  # a symlinked spelling is still the driving daemon (macOS /tmp ->
  # /private/tmp is the canonical field case), so the same-file test
  # guards the refusal too (the bots' finding).
  if [ -n "$live_daemon_socket" ] \
     && { [ "$socket_path" = "$live_daemon_socket" ] \
          || [ "$socket_path" -ef "$live_daemon_socket" ]; } \
     && [ "${PRIME_AGENT_STOP_LIVE_DAEMON:-}" != "1" ]; then
    note "note: ${socket_path} is the daemon this install runs under — it is"
    note "  never probed (stopping it would cut the branch this installer"
    note "  sits on). Set PRIME_AGENT_STOP_LIVE_DAEMON=1 to stop it for a"
    note "  deliberate in-daemon update."
    ts_stop_summary="${ts_stop_summary}daemon: skipped the live daemon socket ${socket_path} (this install runs under it; PRIME_AGENT_STOP_LIVE_DAEMON=1 stops it)
"
    ts_stop_refused="yes"
    return 0
  fi
  if [ -e "$socket_path" ]; then
    verdict="$("$UVPY" "$probe_py" "--kind=${candidate_kind}" "$socket_path" 2>/dev/null)" || verdict="probe-error"
  else
    verdict="absent"
  fi
  case "$verdict" in
    ts:stopped:0)
      ts_stop_found_any="yes"
      last_stop_recorded="yes"
      say "the TypeScript daemon on ${socket_path} stopped cleanly (idle; no signal sent)"
      ts_stop_summary="${ts_stop_summary}ts daemon: stopped cleanly on ${socket_path} (idle; no signal sent; verified down)
"
      ;;
    ts:stopped:*)
      sessions="${verdict##*:}"
      ts_stop_found_any="yes"
      last_stop_recorded="yes"
      say "the TypeScript daemon on ${socket_path} stopped (${sessions} session(s) were live;"
      say "  the graceful request settled it; no signal sent)"
      ts_stop_summary="${ts_stop_summary}ts daemon: stopped on ${socket_path} (serving ${sessions} session(s); the graceful request settled it; verified down)
"
      ;;
    ts:stopped-forced:*)
      sessions="${verdict##*:}"
      ts_stop_found_any="yes"
      last_stop_recorded="yes"
      say "the TypeScript daemon on ${socket_path} stopped (${sessions} session(s) were live;"
      say "  forced after the graceful request; no signal sent)"
      ts_stop_summary="${ts_stop_summary}ts daemon: stopped on ${socket_path} (serving ${sessions} session(s); forced after the graceful request; verified down)
"
      ;;
    rust:stopped:0)
      ts_stop_found_any="yes"
      last_stop_recorded="yes"
      last_stop_was_rust="yes"
      ts_stop_rust_stopped="yes"
      say "the Rust daemon on ${socket_path} stopped for the update (idle; no signal sent)"
      ts_stop_summary="${ts_stop_summary}rust daemon: stopped for the update on ${socket_path} (idle; no signal sent; verified down)
"
      ;;
    rust:stopped:*)
      sessions="${verdict##*:}"
      ts_stop_found_any="yes"
      last_stop_recorded="yes"
      last_stop_was_rust="yes"
      ts_stop_rust_stopped="yes"
      say "the Rust daemon on ${socket_path} stopped for the update (${sessions} session(s)"
      say "  were live; the graceful request settled it; no signal sent)"
      ts_stop_summary="${ts_stop_summary}rust daemon: stopped for the update on ${socket_path} (serving ${sessions} session(s); the graceful request settled it; verified down)
"
      ;;
    rust:stopped-forced:*)
      sessions="${verdict##*:}"
      ts_stop_found_any="yes"
      last_stop_recorded="yes"
      last_stop_was_rust="yes"
      ts_stop_rust_stopped="yes"
      say "the Rust daemon on ${socket_path} stopped for the update (${sessions} session(s)"
      say "  were live; forced after the graceful request; no signal sent)"
      ts_stop_summary="${ts_stop_summary}rust daemon: stopped for the update on ${socket_path} (serving ${sessions} session(s); forced after the graceful request; verified down)
"
      ;;
    ts:replaced:*|rust:replaced:*)
      sessions="${verdict##*:}"
      owner="the TypeScript daemon"
      case "$verdict" in rust:*) owner="the Rust daemon" ;; esac
      ts_stop_found_any="yes"
      note "WARNING: a DIFFERENT daemon took ${socket_path} between the"
      note "  classification and the stop (${owner} was classified there;"
      note "  the new one was never identified): nothing was stopped, and no"
      note "  command was sent to the replacement. Stop it by hand:"
      note "  prime-agent shutdown --force"
      ts_stop_summary="${ts_stop_summary}daemon: WARNING replaced on ${socket_path} (the classified ${owner} was swapped mid-stop; the replacement was never commanded; stop it by hand: prime-agent shutdown --force)
"
      ;;
    ts:stop-failed:*|rust:stop-failed:*)
      sessions="${verdict##*:}"
      owner="the TypeScript daemon"
      case "$verdict" in rust:*) owner="the Rust daemon" ;; esac
      ts_stop_found_any="yes"
      note "WARNING: ${owner} on ${socket_path} is STILL RUNNING after this install"
      note "  (it was serving ${sessions} session(s); the graceful and the forced shutdown"
      note "  requests both failed to bring it down, and no signal was ever sent)."
      note "  Stop it by hand: prime-agent shutdown --force"
      ts_stop_summary="${ts_stop_summary}daemon: WARNING still running on ${socket_path} (${owner}, ${sessions} session(s); the graceful and forced requests did not bring it down; stop it by hand: prime-agent shutdown --force)
"
      ;;
    unrecognized:*)
      schema_id="${verdict#unrecognized:}"
      ts_stop_found_any="yes"
      note "WARNING: a daemon is listening on ${socket_path} but its hello schema"
      note "  (${schema_id}) identifies as neither the TypeScript family"
      note "  (protocol-7-schema-*) nor this product's daemon; nothing was stopped."
      note "  Stop it by hand: prime-agent shutdown --force"
      ts_stop_summary="${ts_stop_summary}daemon: WARNING unrecognized on ${socket_path} (schema ${schema_id}; left running; stop it by hand: prime-agent shutdown --force)
"
      ;;
    no-hello|no-schema)
      ts_stop_found_any="yes"
      note "WARNING: something is listening on ${socket_path} but did not greet"
      note "  with a daemon hello; nothing was stopped (never killed blind)."
      note "  Stop it by hand: prime-agent shutdown --force"
      ts_stop_summary="${ts_stop_summary}daemon: WARNING unidentified on ${socket_path} (no daemon hello; left running; stop it by hand: prime-agent shutdown --force)
"
      ;;
    stale)
      note "note: no daemon answers on ${socket_path} (a stale socket file was left alone)"
      ;;
    probe-error|"")
      ts_stop_found_any="yes"
      note "WARNING: could not probe ${socket_path}; nothing was stopped"
      note "  (never killed blind). Stop it by hand if one is running there:"
      note "  prime-agent shutdown --force"
      ts_stop_summary="${ts_stop_summary}daemon: WARNING unprobed on ${socket_path} (nothing was stopped; stop it by hand: prime-agent shutdown --force)
"
      ;;
    absent)
      :
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
  say "note: a TypeScript native install also lives at ${ts_managed_root}"
  say "  (XDG_DATA_HOME); it does not occupy ${share_dir} and was left in place."
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
printf 'install-rust.sh channel %s\nversion %s\n' "$CHANNEL" "$VERSION" \
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
    note "warning: could not sweep the previous rollback generation ${sweep_dir};"
    note "  it stays (harmless — remove it by hand if you recognize it)"
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
    note "note: ${old_layout_dir} is not this installer's payload tree; it was"
    note "  left in place (no migration, no rollback from it)"
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
    note "warning: could not remove the superseded ${old_layout_dir} tree; remove it by hand"
  else
    say "removed the superseded ${old_layout_dir} tree (its payload now lives under ${share_dir})"
  fi
elif [ -d "$old_layout_dir" ]; then
  note "note: ${old_layout_dir} is not this installer's payload tree; it was left in place"
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
    say "replacing the prime-agent command symlink (was: $(readlink "$launcher" 2>/dev/null || true));"
    say "  the keyword is the Rust port's now"
  elif [ -f "$launcher" ] && grep -q 'launcher written by install-rust.sh' "$launcher" 2>/dev/null; then
    :   # this installer's own previous launcher (a REGULAR file — the
    :   # marker grep never opens a special file): plain replace below
  else
    preserved_cmd_path="$(fresh_slot "${bin_dir}/prime-agent.pre-takeover")"
    mv "$launcher" "$preserved_cmd_path" \
      || die "could not preserve the existing file at ${launcher}; resolve it and re-run"
    preserved_launcher="$preserved_cmd_path"
    note "note: an unrelated prime-agent command existed at ${launcher};"
    note "  it was preserved at ${preserved_cmd_path}"
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
  say "removed the old ${old_launcher} launcher (the keyword is prime-agent now)"
fi

# --- the TypeScript takeover completes AFTER the publish ----------------------
# The TS-side steps that RETIRE the old command — the always-stop daemon
# pass and the npm uninstall — run only once this install has published its
# payload and launcher: a failed install (a refused share dir, a live lock,
# a failed swap) must never leave the machine without a working prime-agent.
# The TS native tree's move to the legacy name cannot be deferred (it
# occupies this installer's publish path); it runs inside the lock with its
# own restore-on-failure and printed rollback instead.
# Every candidate is probed by its named variable (the default TS
# socket, the profile-exported PRIME_AGENT_DAEMON_SOCKET, this product's
# pinned rust socket) — no silent skips, except the one the self-socket
# refusal protects, and no word-split iteration: each named path is
# passed QUOTED, exactly once, so a socket path containing whitespace
# stays one candidate (the bots' finding). The TS candidates classify by
# identity first, then the schema family; the pinned rust socket is OUR
# daemon by construction (the update flow: a running rust daemon holds
# the old binary and venv state, the update needs it down, the next
# invocation boots the new daemon).
last_stop_recorded=""
last_stop_was_rust=""
stop_daemon_candidate "$ts_socket" ts
ts_stop_stopped_ts="$last_stop_recorded"
ts_stop_was_rust_ts="$last_stop_was_rust"
if [ "$env_socket_probe" = "yes" ]; then
  stop_daemon_candidate "$env_socket" ts
  ts_stop_stopped_env="$last_stop_recorded"
  ts_stop_was_rust_env="$last_stop_was_rust"
fi
if [ "$rust_socket_probe" = "yes" ]; then
  stop_daemon_candidate "$rust_socket" ours
  ts_stop_stopped_rust="$last_stop_recorded"
  ts_stop_was_rust_rust="$last_stop_was_rust"
fi

# THE VERIFY (the field contract: the TS daemon is DOWN before the install
# finishes): every socket a stop verdict was recorded for is re-checked
# once more — a daemon that came back between its confirm poll and here
# (a restart loop, a supervisor re-exec) reads as a leftover and gets the
# loud warning that SUPERSEDES its earlier stop line (the summary never
# claims both). The per-candidate flags keep the verify off any path
# list (the same whitespace ruling).
rust_leftover="no"
verify_stopped_socket() {
  last_verify_leftover="no"
  if [ "$("$UVPY" "$probe_py" --listening "$1" 2>/dev/null)" = "up" ]; then
    last_verify_leftover="yes"
    if [ "$2" = "yes" ]; then
      rust_leftover="yes"
    fi
    note "WARNING: the daemon on $1 answered the post-stop verification;"
    note "  it is treated as still running (see the install summary)"
    ts_stop_summary="${ts_stop_summary}daemon: WARNING still running on $1 (it answered the post-stop verification — the earlier stop line for this socket is superseded; stop it by hand: prime-agent shutdown --force)
"
  fi
}
if [ "${ts_stop_stopped_ts:-}" = "yes" ]; then
  verify_stopped_socket "$ts_socket" "$ts_stop_was_rust_ts"
fi
if [ "${ts_stop_stopped_env:-}" = "yes" ]; then
  verify_stopped_socket "$env_socket" "$ts_stop_was_rust_env"
fi
if [ "${ts_stop_stopped_rust:-}" = "yes" ]; then
  verify_stopped_socket "$rust_socket" "$ts_stop_was_rust_rust"
fi

# The TS npm package: uninstalled (operator directive — the Rust port owns the
# keyword), with the restore command printed. Exact package `prime-agent`
# only; best-effort — an npm failure warns and moves on.
if command -v npm >/dev/null 2>&1; then
  npm_root="$(npm root -g 2>/dev/null || true)"
  if [ -n "$npm_root" ] && [ -f "${npm_root}/prime-agent/package.json" ]; then
    ts_version="$("$UVPY" -c 'import json, sys
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
        note "warning: npm uninstall -g prime-agent failed; run it by hand — the"
        note "  npm-installed TS command can shadow ${launcher} on PATH"
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
# THE PRE-WARM'S PATH FIX (the bots' finding): the product's own ensure_uv
# searches PATH and ~/.local/bin/uv, so a payload-adjacent uv (the
# store-alias fallback) is invisible to the launcher unless the prefix's
# bin dir rides PATH — the pre-warm's child inherits this PATH, and the
# profile note below tells the user to make it permanent.
if [ -n "$uv_bin_dir" ] && [ "$uv_bin_dir" != "${HOME}/.local/bin" ]; then
  PATH="${uv_bin_dir}:${PATH}"
  export PATH
fi
if command -v uv >/dev/null 2>&1 \
   || { [ -n "$uv_bin_dir" ] && [ -x "${uv_bin_dir}/uv" ]; }; then
  say "uv found (the kernel venv's package manager)"
else
  if [ -n "$uv_bin_dir" ]; then
    say "installing uv (the kernel venv's package manager — the command the"
    say "product's own error message names):"
  else
    say "uv was not installed (no target outside the shared session store;"
    say "  the first session needs uv on PATH or at ~/.local/bin/uv):"
  fi
  # The fetch and the script run are checked SEPARATELY: a plain
  # `curl | sh` pipeline reports the SCRIPT's status, so a dead network
  # (curl fails, sh reads nothing and exits 0) would masquerade as success.
  # The computed uv target is passed EXPLICITLY (the default path in the
  # normal case, the payload-adjacent prefix bin dir under the store
  # alias — the store-alias fallback above), which also overrides any
  # inherited value pointing into the shared session store.
  if [ -n "$uv_bin_dir" ] \
     && curl_out="$(curl -LsSf https://astral.sh/uv/install.sh)" \
     && printf '%s\n' "$curl_out" \
        | env -u UV_UNMANAGED_INSTALL UV_INSTALL_DIR="$uv_bin_dir" sh; then
    [ -x "${uv_bin_dir}/uv" ] \
      || note "warning: the uv installer reported success but ${uv_bin_dir}/uv is missing; the first session may need to install uv itself"
  else
    note "warning: could not install uv; the kernel pre-warm was skipped."
    note "  The first session needs uv — install it with:"
    note "  curl -LsSf https://astral.sh/uv/install.sh | sh"
  fi
fi
if command -v uv >/dev/null 2>&1 \
   || { [ -n "$uv_bin_dir" ] && [ -x "${uv_bin_dir}/uv" ]; }; then
  if bootstrap_out="$("$launcher" --prime-agent-bootstrap 2>&1)"; then
    say "kernel pre-warmed: the first session's Python kernel is ready"
    say "$bootstrap_out"
  else
    note "warning: the kernel pre-warm failed (the install stands; the first"
    note "  session will retry it online):"
    note "$bootstrap_out"
  fi
else
  note "note: kernel pre-warm skipped (no uv); the first session bootstraps"
  note "  the kernel itself and needs the network once"
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
if [ -d "$old" ] && grep -qxF -- "$old" "$generations_record" 2>/dev/null; then
  echo "rollback:  ${old} (the previous payload, one generation; swept on the next install)"
elif [ -d "$old" ]; then
  echo "rollback:  ${old} (the migrated pre-takeover tree; kept — remove it by hand"
  echo "            once you no longer need the rollback)"
fi
echo "source:    the ${CHANNEL} channel at ${BASE_URL} (prime-agent ${VERSION})"
if [ -n "$ts_stop_summary" ]; then
  printf '%s' "$ts_stop_summary"
elif [ -z "$ts_stop_found_any" ] && [ -z "$ts_stop_refused" ]; then
  # No silent skips: a machine with no daemon anywhere says so, naming
  # every candidate that was probed.
  echo "daemon: none found (no daemon answered on: ${ts_candidate_report})"
fi

echo "next steps: the README's Install section ships inside the payload"
echo "  ${share_dir}/README.md"
if [ "$ts_stop_rust_stopped" = "yes" ] && [ "$rust_leftover" != "yes" ]; then
  # The update flow's half: the stopped daemon was OURS — the next
  # invocation boots the fresh payload this install just published. A
  # rust daemon that answered the post-stop verification is NOT "stopped
  # for the update": the warning line says so, and this line stays silent
  # (the bots' finding — the summary must never claim both).
  echo "  the previous Rust daemon was stopped for this update — the next"
  echo "  prime-agent invocation boots the new daemon"
fi

rm -rf "$dl"
