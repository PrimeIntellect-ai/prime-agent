# Bot guest image

The runtime a bot sandbox boots before the daemon installs its own
prime-agent version. A bot whose version already matches this image
skips the install entirely.

## Contents

| Part | Source |
|---|---|
| Base | `python:3.12-bookworm` (public Docker Hub), the same base bots booted before this image existed |
| `prime-agent` | One linux-x64 release tarball, installed with its own `install.sh --archive`, in the managed layout `~/.local/share/prime-agent` |
| uv + kernel venv | Installed by that same `install.sh` bootstrap (`~/.local/bin/uv`, `~/.prime/agent/kernel-venv`), so the layout and the venv identity match a live guest |
| Node.js | v22.23.5, pinned and checksummed, at `/opt/node` with links in `/usr/local/bin` |
| GitHub CLI | v2.105.0, pinned and checksummed, at `/opt/gh` with links in `/usr/local/bin` |
| uv cache | Kept from the install, so a dev-build venv rebuild needs no downloads |

`bots::version::INSTALL_SCRIPT` installs the same two tools with the same
versions and checksums. Change both in one commit.

## Build and publish

```bash
make bot-image VERSION=0.10.3
# or with a local tarball (a dev build, or a release not on GitHub):
make bot-image VERSION=0.10.3-dev-180 BOT_TARBALL=/path/prime-agent-0.10.3-dev-180-linux-x64.tar.gz
```

`make bot-image` runs `prepare.sh`, pushes the build context with
`prime images push` (server-side build; no local Docker), waits for the
build to complete, then creates and deletes one short-lived sandbox. That
first create converts the container image into a VM artifact, so the
first bot of a new tag does not sit in `PENDING`.

The tag defaults to `latest`. `bots::DEFAULT_BOT_IMAGE` points at
`prime/primeintellect/prime-agent-bot:latest`, so a plain
`make bot-image VERSION=...` republishes what bots boot.

## Registry and access

- The image lives in the Prime registry under the team slug:
  `prime/primeintellect/prime-agent-bot:<tag>`. Sandbox creates resolve
  `prime/` references to Prime Images; other public registries are not
  accepted directly.
- The daemon's sandbox client already scopes creates to the owner's
  Prime team, so a team image needs no extra configuration.
- The image is **team-private**. The base is public, but the image also
  carries a prime-agent build; publish it only where that build may go.
- Push with a Prime API key that has images and sandbox permissions. Use
  `PRIME_TEAM_ID` to scope the push without changing the CLI's default
  team.

## When to rebuild

- On each release whose bots should skip the install. A bot on another
  version still works: it installs its own build at create (or resume).
- When the pinned Node.js, GitHub CLI, uv or base image changes.
- When the kernel venv schema changes, so the image carries a fresh venv.

Nothing pushes this image from CI. It is a manual, low-frequency step.

## Disk and cost

The built image is roughly 1.5-2 GB compressed. A bot's sandbox disk is
20 GB, so the image leaves ample room for the guest's sessions, logs and
checkpoints.
