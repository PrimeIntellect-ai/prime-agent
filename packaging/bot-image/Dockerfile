# The bot guest image: the runtime every bot boots before the daemon
# installs its own version.
#
# It is built by running the real guest install, so the layout matches what
# `bots::version::INSTALL_SCRIPT` produces in a live sandbox: the managed
# prime-agent tree (`~/.local/share/prime-agent`), uv, the kernel venv, the
# uv cache, Node.js and the GitHub CLI. The bot bootstrap then only starts
# the guest daemon.
#
# `prepare.sh` stages the release tarball in this directory, and
# `make bot-image` pushes the result to the team registry. The tarball is
# never committed.
FROM python:3.12-bookworm

# The guest's own PATH: the installer and the bot bootstrap resolve
# prime-agent and uv here.
ENV PATH="/root/.local/bin:${PATH}"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git; \
    rm -rf /var/lib/apt/lists/*

COPY prime-agent.tar.gz /tmp/prime-agent.tar.gz
# The release the image carries; `prepare.sh` writes this file.
COPY version /tmp/bot-version

# Install with the release's own installer, under the exact archive name it
# requires. This also installs uv and pre-warms the kernel venv, so a bot
# whose version matches needs no download at create time. A login shell
# resets PATH on this base, so the two binaries also go on the system path;
# the installer's prime-agent is a launcher that resolves its payload from
# its own path, so it gets a wrapper and not a symlink.
RUN set -eux; \
    version="$(cat /tmp/bot-version)"; \
    archive="/tmp/prime-agent-${version}-linux-x64.tar.gz"; \
    cd /tmp; \
    mv prime-agent.tar.gz "$archive"; \
    tar -xzf "$archive" install.sh; \
    sh ./install.sh --archive "$archive" --force; \
    test "$(prime-agent --version)" = "$version"; \
    prime-agent relay --probe; \
    { echo '#!/bin/sh'; echo 'exec /root/.local/bin/prime-agent "$@"'; } > /usr/local/bin/prime-agent; \
    chmod 0755 /usr/local/bin/prime-agent; \
    sh /usr/local/bin/prime-agent --version; \
    ln -sf /root/.local/bin/uv /usr/local/bin/uv; \
    PATH=/usr/local/bin:/usr/bin:/bin prime-agent --version; \
    rm -f "$archive" /tmp/install.sh /tmp/bot-version

# The guest tools the installer adds at create time, pinned to the same
# versions and checksums as `bots::version::INSTALL_SCRIPT`, pre-installed
# here so a matching release downloads nothing.
RUN set -eux; \
    cd /tmp; \
    curl -fsSL --retry 3 -o node.tar.gz \
      https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-x64.tar.gz; \
    echo "c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1  node.tar.gz" \
      | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xzf node.tar.gz -C /opt/node --strip-components=1 --no-same-owner; \
    ln -sf /opt/node/bin/* /usr/local/bin/; \
    curl -fsSL --retry 3 -o gh.tar.gz \
      https://github.com/cli/cli/releases/download/v2.105.0/gh_2.105.0_linux_amd64.tar.gz; \
    echo "79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f  gh.tar.gz" \
      | sha256sum -c -; \
    mkdir -p /opt/gh; \
    tar -xzf gh.tar.gz -C /opt/gh --strip-components=1 --no-same-owner; \
    ln -sf /opt/gh/bin/* /usr/local/bin/; \
    rm -f node.tar.gz gh.tar.gz; \
    node --version; \
    gh --version | head -1; \
    uv --version

WORKDIR /root

LABEL org.opencontainers.image.title="prime-agent-bot" \
      org.opencontainers.image.description="Prime Agent bot guest runtime"
