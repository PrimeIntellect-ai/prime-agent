# Prime Agent cloud image (tunnel runtime)

Build recipe for the pinned Prime VM image used by direct-cloud tunnel
delegations (`/cloud run --tunnel`, `PRIME_AGENT_CLOUD_IMAGE`).

Contents: the validated Prime Agent Debian runtime base plus the currently
published `prime-agent` (v0.9.5) and `frpc` 0.66.0 on `PATH`
(`/usr/local/bin/frpc`), which the uploaded guest bridge spawns as
`PRIME_AGENT_CLOUD_FRPC_BIN=frpc` to forward the Prime Tunnel edge to the
loopback bridge listener. No credentials are baked into the image.

## Inputs

| Input | Value |
|---|---|
| Base | `icarus-prime-agent-slack-test` container digest `sha256:ee65460493c6f9597105d5960a92d96d831720652feccbc641397c46971801c4` (validated in Prime VM sandboxes 2026-09-17: Debian 12, bash 5.2.15, git 2.39.5, tar 1.34, node 22.23.1, python3 3.11.2, kernel venv 3.11.15, uv 0.11.28). Pinned by digest, never by tag. |
| `prime-agent` | v0.9.5, the currently published release containing this repo's base commit. Tarball sha256 `349f1682c7909550842f1b04a71ba95814341b136474ade736df93f8ec006876` (GitHub release `SHA256SUMS`; public R2 mirror `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.9.5/prime-agent-0.9.5.tgz`). |
| frp release | v0.66.0 from https://github.com/fatedier/frp/releases/tag/v0.66.0 |
| frp tarball sha256 (upstream `frp_sha256_checksums.txt`) | `317a17a7adac2e6bed2d7a83dc077da91ced0d110e1636373ece8ae5ac8b578b` |
| frpc binary sha256 | `2fb1a9cf50f5d0872be868edd0c5f438e211f221b7edfff3615b149d89b94524` |

The Dockerfile verifies every checksum inside the build and fails otherwise.
`prepare.sh` fetches the two release artifacts into this directory and
verifies them against `checksums.sha256`; the artifacts are gitignored and
never committed, so the repo stays small and the build context stays
reproducible.

The base image was prepared for prime-agent 0.2.9 and can carry a stale agent
config (`/root/.prime/agent/settings.json`, old kernel venv) or an inherited
`PRIME_AGENT_CODING_AGENT_DIR` override. A stale settings file can break the
current agent's Bash tool at startup (for example a `shellPath` that no longer
exists throws before any command runs), so the Dockerfile wipes
`/root/.prime/agent` and `/root/.config/pi` and resets the override to empty
before the fresh install bootstraps its own config.

## Rebuild

```bash
# 1. Prepare the local build context (downloads + verifies the artifacts).
./prepare.sh

# 2. Build and push the container image under the PI Research team. The
#    PRIME_TEAM_ID environment override scopes this one command to the team
#    without changing the CLI's global team selection (server-side Kaniko;
#    new tags are immutable once pushed).
PRIME_TEAM_ID=clyvldofb0000gg1kx39rgzjq prime images push \
    prime-agent-frpc:0.9.5-frpc0.66.0 \
    --context packages/coding-agent/cloud-image \
    --dockerfile packages/coding-agent/cloud-image/Dockerfile

# 3. Build the VM artifact under the same team.
PRIME_TEAM_ID=clyvldofb0000gg1kx39rgzjq prime images build-vm \
    prime/primeintellect/prime-agent-frpc:0.9.5-frpc0.66.0
```

The container build runs server-side and pulls the base by digest from the
Prime registry; the VM artifact build converts the finished container image
into a VM sandbox image. Re-pushing the same tag replaces the logical image
contents; pin consumers to the pushed container digest instead of the tag.

Pushed artifacts for this tag (PI Research team):

- Container: `cmodl2lat001h4xo52tkp3f9m/prime-agent-frpc@sha256:7081d20b8c97487b143c6eea98ea8ea3689e128933a67a2c29f7266698856e3e`
- VM sandbox: `cmodl2lat001h4xo52tkp3f9m/<build-id>/linux-amd64/rootfs-cas`

Gate (2026-09-17, one short-lived VM): `prime-agent --version` = 0.9.5,
`frpc --version` = 0.66.0 with binary sha256
`2fb1a9cf50f5d0872be868edd0c5f438e211f221b7edfff3615b149d89b94524`,
node v22.23.1, git 2.39.5, GNU tar 1.34, bash 5.2.15, python3 3.11.2, and
`prime-agent --print` (scoped guest key + `PRIME_TEAM_ID`) answered "ok" and
exited 0 in ~4s.
