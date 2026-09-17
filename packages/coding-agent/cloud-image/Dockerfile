# Prime Agent cloud runtime image for direct-cloud sandbox delegation with the
# Prime Tunnel bridge (`/cloud run --tunnel`, `PRIME_AGENT_CLOUD_IMAGE`).
#
# Contents: the validated Debian 12 runtime base (node 22.23.1, git 2.39.5,
# tar 1.34, bash 5.2.15, python3 + uv kernel tooling) with the currently
# published `prime-agent` (v0.9.5) and checksum-pinned frpc 0.66.0 on PATH.
# The base is pinned by immutable digest, never by tag; both artifacts are
# prepared into the local build context by prepare.sh (they are never
# committed to the repo) and verified inside this build. No credentials are
# baked into the image.
FROM us-central1-docker.pkg.dev/prime-intellect-platform/prod-sandbox/cmodl2lat001h4xo52tkp3f9m/icarus-prime-agent-slack-test@sha256:ee65460493c6f9597105d5960a92d96d831720652feccbc641397c46971801c4

# `prime-agent-0.9.5.tgz` is the v0.9.5 release tarball (R2 mirror:
# https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.9.5/prime-agent-0.9.5.tgz,
# matching the GitHub release SHA256SUMS entry).
# `frp_0.66.0_linux_amd64.tar.gz` is the frp v0.66.0 release tarball
# (https://github.com/fatedier/frp/releases/tag/v0.66.0).
COPY checksums.sha256 prime-agent-0.9.5.tgz frp_0.66.0_linux_amd64.tar.gz /tmp/

# The base was prepared for prime-agent 0.2.9 and carries stale agent
# overrides: PRIME_AGENT_KERNEL_PYTHON points at its 0.2.9-era kernel venv
# (removed below, and whose runtime lacks the current rlm.* API), and
# /root/.prime/agent may hold 0.2.9-era settings. 0.9.5 honors the kernel-python
# override instead of auto-bootstrapping, which makes every kernel/bash call
# fail at startup, so both overrides must be reset to empty (getAgentDir and
# the kernel bootstrapper treat empty as unset) and the stale config wiped
# before the fresh install bootstraps its own config.
ENV PRIME_AGENT_CODING_AGENT_DIR=""
ENV PRIME_AGENT_KERNEL_PYTHON=""

RUN set -eux; \
    rm -rf /root/.prime/agent /root/.config/pi; \
    cd /tmp; \
    sha256sum -c checksums.sha256; \
    tar -xzf frp_0.66.0_linux_amd64.tar.gz -C /tmp; \
    echo "2fb1a9cf50f5d0872be868edd0c5f438e211f221b7edfff3615b149d89b94524  /tmp/frp_0.66.0_linux_amd64/frpc" | sha256sum -c -; \
    install -m 0755 /tmp/frp_0.66.0_linux_amd64/frpc /usr/local/bin/frpc; \
    PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1 npm install -g /tmp/prime-agent-0.9.5.tgz; \
    rm -rf /tmp/checksums.sha256 /tmp/prime-agent-0.9.5.tgz /tmp/frp_0.66.0_linux_amd64 /tmp/frp_0.66.0_linux_amd64.tar.gz; \
    hash -r; \
    command -v frpc prime-agent node git tar bash; \
    frpc --version; \
    prime-agent --version; \
    node --version; \
    git --version; \
    tar --version | head -1; \
    bash --version | head -1
