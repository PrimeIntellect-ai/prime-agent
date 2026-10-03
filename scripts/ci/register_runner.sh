#!/usr/bin/env bash
# Register and run a GitHub Actions self-hosted runner inside a Prime sandbox
# VM (docs/sandbox-runners.md). Runs ONCE per sandbox provision, as root; it
# drops to the dedicated runner user for everything that touches GitHub.
#
# Environment (the sandbox SDK injects secrets as env vars; the registration
# token is a one-hour credential and MUST NOT be logged or written to disk;
# it does cross as argv to the register script and config.sh, so it is
# briefly visible to root and the runner user via ps):
#   RUNNER_TOKEN   REQUIRED. A fresh registration token (minted per
#                  provision; see docs/sandbox-runners.md for both mint
#                  routes). Missing => hard fail, no partial state.
#   RUNNER_URL     Registration scope. Default: this repository
#                  (https://github.com/PrimeIntellect-ai/prime-agent), so no
#                  other repository can run jobs on the runner. An org URL
#                  is only safe with a runner group limited to this repo.
#   RUNNER_NAME    Runner name shown in the repo runner list.
#                  Default: prime-runner-<full sandbox hostname> (the full
#                  hostname keeps names unique; --replace must not be able
#                  to reach a different live runner).
#   RUNNER_LABELS  Comma-separated labels jobs target.
#                  Default: prime-linux-x64. Registered with
#                  --no-default-labels, so runs-on: self-hosted jobs do
#                  NOT land on these runners.
#   RUNNER_DIR     Default: /opt/gh-runner. Must be a dedicated directory
#                  under /opt (it is chowned recursively to the runner user).
#   RUNNER_USER    Default: gh-runner.
#
# The runner tarball is pinned (version + sha256); the digest is reviewed
# like any other dependency pin. Pinned: v2.337.0.
set -euo pipefail

RUNNER_URL="${RUNNER_URL:-https://github.com/PrimeIntellect-ai/prime-agent}"
# The full hostname keeps names unique across the fleet: a short suffix
# could collide between two live runners, and --replace would then take
# the name over from a runner that is still serving jobs.
RUNNER_NAME="${RUNNER_NAME:-prime-runner-$(hostname)}"
RUNNER_LABELS="${RUNNER_LABELS:-prime-linux-x64}"
RUNNER_DIR="${RUNNER_DIR:-/opt/gh-runner}"
RUNNER_USER="${RUNNER_USER:-gh-runner}"
RUNNER_VERSION="2.337.0"
RUNNER_SHA256="70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"
RUNNER_TARBALL="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
RUNNER_DOWNLOAD="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_TARBALL}"

log() { printf '[register_runner] %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { log "must run as root (the provision step)"; exit 1; }
[ -n "${RUNNER_TOKEN:-}" ] || { log "RUNNER_TOKEN is required (mint a fresh one; it lives 1 hour)"; exit 1; }
case "${RUNNER_URL}" in
  https://github.com/*) ;;
  *) log "RUNNER_URL must be an https://github.com/... URL"; exit 1 ;;
esac
case "${RUNNER_DIR}" in
  /opt/*[!/]*) ;;
  *) log "RUNNER_DIR must be a dedicated directory under /opt"; exit 1 ;;
esac

# The runner refuses to run as root, so the agent runs as a dedicated user
# with no sudo grants: that user is the security boundary between job code
# and the provision layer.
if ! id -u "${RUNNER_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${RUNNER_USER}"
  passwd -l "${RUNNER_USER}" >/dev/null 2>&1 || true
fi

# Job steps run as the sudo-less runner user, so everything the build-gnu
# jobs need is installed here, as root: the runner agent's deps, the native
# build tools, and the aarch64 cross toolchain + qemu-user for the
# prime-linux-arm64 leg (installed on every runner so any runner can take
# either label).
log "installing runner host prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends \
  ca-certificates curl git jq libicu70 libkrb5-3 zlib1g \
  build-essential python3 pkg-config binutils \
  gcc-aarch64-linux-gnu binutils-aarch64-linux-gnu libc6-arm64-cross \
  qemu-user-static binfmt-support

# The arm64 leg's livechecks run the aarch64 binary through qemu-user binfmt.
log "enabling qemu-aarch64 binfmt"
mountpoint -q /proc/sys/fs/binfmt_misc || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc
update-binfmts --enable qemu-aarch64
[ -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ] || { log "qemu-aarch64 binfmt did not register"; exit 1; }

mkdir -p "${RUNNER_DIR}"
if [ -f "${RUNNER_DIR}/.runner" ]; then
  log "already registered (fresh-provision contract violated): refusing to double-register"
  exit 1
fi

log "fetching runner v${RUNNER_VERSION} (sha256-pinned)"
curl -fsSL -o "/tmp/${RUNNER_TARBALL}" "${RUNNER_DOWNLOAD}"
echo "${RUNNER_SHA256}  /tmp/${RUNNER_TARBALL}" | sha256sum -c -
tar -xzf "/tmp/${RUNNER_TARBALL}" -C "${RUNNER_DIR}"
rm -f "/tmp/${RUNNER_TARBALL}"
chown -R "${RUNNER_USER}:${RUNNER_USER}" "${RUNNER_DIR}"

# config.sh validates the token against GitHub and writes the registration
# state; the token only ever crosses as an argv (never logged, never echoed
# by this script). The registration runs from a fixed script file that
# takes the values as positional parameters (the runner-supervise.sh
# pattern: no nested quoting through a su -c shell string), so a quote in
# any value is data, never shell syntax. A bad/expired token fails in
# config.sh, leaving no partial registration. --replace takes the name over
# from a stale registration: the sandbox lifetime cap rotates VMs weekly
# and the name is hostname-derived, and GitHub keeps listing the old entry
# as Offline after the VM is gone (a deleted VM cannot deregister itself;
# the entry lingers until removed manually or after >14 days disconnected).
# Without --replace that leftover name fails provisioning of the fresh VM
# and leaves prime-linux-* jobs queued.
log "registering '${RUNNER_NAME}' with labels [${RUNNER_LABELS}] at ${RUNNER_URL}"
cat > "${RUNNER_DIR}/runner-register.sh" <<'REGISTER'
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
exec ./config.sh --unattended \
  --url "$1" \
  --token "$2" \
  --name "$3" \
  --labels "$4" \
  --no-default-labels \
  --replace
REGISTER
chown "${RUNNER_USER}:${RUNNER_USER}" "${RUNNER_DIR}/runner-register.sh"
chmod 700 "${RUNNER_DIR}/runner-register.sh"
# The -- terminator is load-bearing: su parses options among trailing args
# (getopt permutation), so a value like -c in RUNNER_NAME/LABELS - or in
# RUNNER_USER itself - would be consumed by su itself; -- before any value
# ends option parsing, and everything after it is passed to the script as
# plain argv.
su -s /bin/bash -- "${RUNNER_USER}" "${RUNNER_DIR}/runner-register.sh" \
  "${RUNNER_URL}" "${RUNNER_TOKEN}" "${RUNNER_NAME}" "${RUNNER_LABELS}"
# su keeps the caller's environment: drop the token so the supervisor, the
# agent, and every job it runs never see it.
unset RUNNER_TOKEN

# Sandboxes have no systemd (the sandbox init is not systemd): run the agent
# under a restart-on-exit supervision loop instead of svc.sh. The loop is a
# small script file in the runner directory (no nested quoting through
# su/bash -c layers); it logs each exit, and a stopped runner shows up as
# Offline in the runner list, which is the alerting surface
# (docs/sandbox-runners.md).
log "starting the runner agent (supervision loop)"
cat > "${RUNNER_DIR}/runner-supervise.sh" <<'SUPERVISE'
#!/bin/bash
cd "$(dirname "$0")"
while true; do
  ./run.sh
  rc=$?
  printf '[register_runner] run.sh exited rc=%s at %s; restarting in 10s\n' \
    "$rc" "$(date -u +%FT%TZ)" >> runner-supervisor.log
  sleep 10
done
SUPERVISE
chown "${RUNNER_USER}:${RUNNER_USER}" "${RUNNER_DIR}/runner-supervise.sh"
chmod 700 "${RUNNER_DIR}/runner-supervise.sh"
# The detachment lives outside any shell string: su runs the fixed script
# as its bash operand (the -- again ends su's option parsing before any
# value), setsid/nohup background it as a new session, and no value is
# ever shell source. The supervise loop never exits, so the backgrounded
# su tree stays alive for the sandbox's life - same lifetime contract as
# the previous inline-setsid form.
setsid nohup su -s /bin/bash -- "${RUNNER_USER}" "${RUNNER_DIR}/runner-supervise.sh" \
  > /dev/null 2>&1 < /dev/null &

log "runner provisioned: name=${RUNNER_NAME} labels=[${RUNNER_LABELS}] dir=${RUNNER_DIR}"
log "verify: it should appear Idle in the GitHub runner list within a minute"
