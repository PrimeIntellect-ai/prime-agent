# Prime Agent cloud image (Rust resident runtime)

Build recipe for the pinned Linux image used by the Rust-native cloud
sandbox delegation foundation: the validated Prime Agent Debian runtime
base plus the **Rust** `prime-agent` v0.9.7 release tree (installed in the
agent's own managed layout) and `frpc` 0.66.0 on PATH
(`/usr/local/bin/frpc`), which the guest bridge spawns as
`PRIME_AGENT_CLOUD_FRPC_BIN=frpc` to forward the Prime Tunnel edge to the
loopback bridge listener. No credentials are baked into the image.

This is the Rust port of the TS `cloud-image/` recipe (TS branch
`feat/direct-cloud-sandbox`, which installs the npm distribution); the
guest runs the native binary from the release tarball instead.

## Inputs

| Input | Value |
|---|---|
| Base | `icarus-prime-agent-slack-test` container digest `sha256:ee65460493c6f9597105d5960a92d96d831720652feccbc641397c46971801c4` (validated in Prime VM sandboxes 2026-09-17: Debian 12, bash 5.2.15, git 2.39.5, tar 1.34, python3 3.11.2, uv 0.11.28, node 22.23.1). Pinned by digest, never by tag. |
| `prime-agent` | v0.9.7 Rust release tarball `prime-agent-0.9.7-linux-x64.tar.gz` (GitHub release, matching the published `SHA256SUMS`). Tarball sha256 `47981c19396bcaabfabc4d6d788e64d55c057288d8676fc5733ab525803be066`. |
| frp release | v0.66.0 from https://github.com/fatedier/frp/releases/tag/v0.66.0 |
| frp tarball sha256 (upstream `frp_sha256_checksums.txt`) | `317a17a7adac2e6bed2d7a83dc077da91ced0d110e1636373ece8ae5ac8b578b` (verified locally against the downloaded tarball 2026-09-29) |
| frpc binary sha256 | `2fb1a9cf50f5d0872be868edd0c5f438e211f221b7edfff3615b149d89b94524` (verified locally against the downloaded tarball 2026-09-29) |

The Dockerfile verifies every checksum inside the build and fails
otherwise; `prepare.sh` fetches the two release artifacts into this
directory and verifies them against `checksums.sha256`. The artifacts are
gitignored and never committed, so the repo stays small and the build
context stays reproducible.

## Install layout

The tarball is extracted into the agent's own managed layout —
`~/.local/share/prime-agent` (`.managed` = `prime-agent-native-v1`),
`releases/0.9.7-linux-x64-<sha256>/` (the full tarball tree: binary,
`prime-agent-runtime/` kernel sidecar, `skills/`, bundled catalog
assets), and the `bin/prime-agent` symlink — the exact shape
`pa-core::update::install` resolves, so the guest's self-update flow
recognizes the install. The stale TS-era config (`/root/.prime/agent`,
`/root/.config/pi`) is wiped and the
`PRIME_AGENT_CODING_AGENT_DIR`/`PRIME_AGENT_KERNEL_PYTHON` overrides are
reset to empty (both treat empty as unset) before the fresh install
bootstraps its own config and kernel venv (python3 + uv from the base).

## Rebuild (team-scoped; `<team-id>` is your Prime team id)

```bash
# 1. Prepare the local build context (downloads + verifies the artifacts,
#    stages the agent tarball as the fixed name the Dockerfile COPYs).
./prepare.sh
#    Deployment rebuild: ./prepare.sh --version <v> --sha256 <tarball-sha256>

# 2. Build and push the container image under your Prime team
#    (server-side Kaniko; PRIME_TEAM_ID scopes the one command without
#    changing the CLI's global team selection).
PRIME_TEAM_ID=<team-id> prime images push \
    prime-agent-rust:0.9.7-frpc0.66.0 \
    --context packaging/cloud-image \
    --dockerfile packaging/cloud-image/Dockerfile \
    --build-arg RELEASE_VERSION=0.9.7 \
    --build-arg RELEASE_PLATFORM=linux-x64 \
    --build-arg RELEASE_SHA256=47981c19396bcaabfabc4d6d788e64d55c057288d8676fc5733ab525803be066

# 3. Build the VM artifact under the same team.
PRIME_TEAM_ID=<team-id> prime images build-vm \
    prime/primeintellect/prime-agent-rust:0.9.7-frpc0.66.0
```

The container build runs server-side and pulls the base by digest from
the Prime registry; the VM artifact build converts the finished container
image into a VM sandbox image. Re-pushing the same tag replaces the
logical image contents; pin consumers to the pushed container digest
instead of the tag.

## Provenance, deployment, and distribution caveats

- **Artifact proof.** The v0.9.7 tarball sha256 was verified locally
  (2026-09-29) against the published release `SHA256SUMS`, and the
  embedded `prime-agent` was confirmed to be the linux-x64 ELF executable
  the release workflow builds (`ELF 64-bit LSB executable, x86-64,
  dynamically linked`). The Dockerfile re-verifies every checksum inside
  the build and fails otherwise.
- **The 0.9.7 pin is a validated reference, not a deployment contract.**
  The cloud runtime that ships with the Rust agent must be built from the
  same release the deployed agent build comes from: rebuild this recipe
  with `./prepare.sh --version <v> --sha256 <tarball-sha256>` and the
  matching `--build-arg` set at deployment time. A stale reference pin
  silently gives the guest an agent that predates its host-side client.
- **The base image is private provenance.** `icarus-prime-agent-slack-test`
  lives in Prime's own registry (`us-central1-docker.pkg.dev/
  prime-intellect-platform/...`), pinned by digest. It is a validated
  convenience base for Prime-internal builds — this recipe is **not
  publicly distributable** as-is. A public lane needs either a published
  base image on a public registry or a Prime-published prebuilt VM
  artifact; only the rebuild commands above would change.
- **Team-scoped push.** `prime images push`/`build-vm` build under a Prime
  team (`<team-id>`); images are not public artifacts.

## Status (2026-09-29)

Definition + pinned inputs only. **No image has been pushed and no gate
run has been executed** — pushing is a real cloud resource and is deferred
until the foundation PR is reviewed. The first gate run should follow the
TS pattern: one short-lived VM from the built artifact, then
`prime-agent --version` = 0.9.7 (Rust build), `frpc --version` = 0.66.0
with the binary sha256 above, and a `prime-agent --print`-equivalent
guest smoke.
