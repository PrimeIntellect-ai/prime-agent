# Prime Agent cloud runtime image for Rust-native cloud sandbox delegation
# (the `feat/direct-cloud-sandbox` port's resident image; the Rust binary,
# not the TS npm distribution).
#
# Contents: the validated Debian 12 runtime base (bash 5.2.15, git 2.39.5,
# tar 1.34, python3 3.11.2 + uv 0.11.28, node 22.23.1) with the Rust
# `prime-agent` v0.9.7 linux-x64 release tree installed in its own managed
# layout (`~/.local/share/prime-agent`, `.managed` marker, `releases/`
# tree, `bin/prime-agent` symlink — the shape `pa-core::update::install`
# resolves) and checksum-pinned frpc 0.66.0 on PATH for the Prime Tunnel
# bridge. The base is pinned by immutable digest, never by tag; both
# release artifacts are prepared into the local build context by prepare.sh
# (they are never committed to the repo) and verified inside this build.
# No credentials are baked into the image.
FROM us-central1-docker.pkg.dev/prime-intellect-platform/prod-sandbox/cmodl2lat001h4xo52tkp3f9m/icarus-prime-agent-slack-test@sha256:ee65460493c6f9597105d5960a92d96d831720652feccbc641397c46971801c4

# `prime-agent-release.tar.gz` is the Rust release tarball prepare.sh
# fetched and verified (default: v0.9.7 linux-x64; files at the tarball
# root: the `prime-agent` binary, `prime-agent-runtime/` kernel sidecar,
# `skills/`, bundled catalog assets).
# checksums.sha256 pins only frp (the version-stable artifact); the agent
# tarball is verified against the RELEASE_SHA256 build arg (the deployment-time
# pin; default: the validated v0.9.7 release).
# `frp_0.66.0_linux_amd64.tar.gz` is the frp v0.66.0 release tarball
# (https://github.com/fatedier/frp/releases/tag/v0.66.0).
COPY checksums.sha256 prime-agent-release.tar.gz frp_0.66.0_linux_amd64.tar.gz /tmp/

# The base was prepared for the TS prime-agent 0.2.9 and carries stale agent
# overrides (a PRIME_AGENT_KERNEL_PYTHON pointing at its removed 0.2.9-era
# kernel venv, and possibly stale /root/.prime/agent settings). Both
# overrides are reset to empty (the CLI and kernel bootstrapper treat empty
# as unset) and the stale config wiped before the fresh install bootstraps
# its own.
ENV PRIME_AGENT_CODING_AGENT_DIR=""
ENV PRIME_AGENT_KERNEL_PYTHON=""

ARG RELEASE_VERSION=0.9.7
ARG RELEASE_PLATFORM=linux-x64
ARG RELEASE_SHA256=47981c19396bcaabfabc4d6d788e64d55c057288d8676fc5733ab525803be066

RUN set -eux; \
    rm -rf /root/.prime/agent /root/.config/pi; \
    cd /tmp; \
    sha256sum -c checksums.sha256; \
    test "$(sha256sum prime-agent-release.tar.gz | cut -d' ' -f1)" = "$RELEASE_SHA256"; \
    tar -xzf frp_0.66.0_linux_amd64.tar.gz -C /tmp; \
    echo "2fb1a9cf50f5d0872be868edd0c5f438e211f221b7edfff3615b149d89b94524  /tmp/frp_0.66.0_linux_amd64/frpc" | sha256sum -c -; \
    install -m 0755 /tmp/frp_0.66.0_linux_amd64/frpc /usr/local/bin/frpc; \
    root=/root/.local/share/prime-agent; \
    release="${RELEASE_VERSION}-${RELEASE_PLATFORM}-${RELEASE_SHA256}"; \
    mkdir -p "$root/releases/$release" "$root/bin" /root/.local/bin; \
    tar -xzf /tmp/prime-agent-release.tar.gz -C "$root/releases/$release"; \
    chmod 0755 "$root/releases/$release/prime-agent"; \
    printf 'prime-agent-native-v1\n' > "$root/.managed"; \
    ln -sfn "../releases/$release/prime-agent" "$root/bin/prime-agent"; \
    ln -sfn "$root/bin/prime-agent" /root/.local/bin/prime-agent; \
    rm -rf /tmp/checksums.sha256 /tmp/prime-agent-release.tar.gz /tmp/frp_0.66.0_linux_amd64 /tmp/frp_0.66.0_linux_amd64.tar.gz; \
    hash -r; \
    command -v frpc git tar bash python3 uv; \
    PATH="/root/.local/bin:$PATH" command -v prime-agent; \
    frpc --version; \
    PATH="/root/.local/bin:$PATH" prime-agent --version; \
    git --version; \
    tar --version | head -1; \
    bash --version | head -1; \
    python3 --version; \
    uv --version

ENV PATH="/root/.local/bin:${PATH}"
