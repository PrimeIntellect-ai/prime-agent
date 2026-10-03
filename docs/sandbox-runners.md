# Self-hosted CI runners on Prime sandboxes (Linux)

The Linux legs of `continuous.yml` and `release.yml` build on our own infra:
Prime sandbox microVMs that run the GitHub Actions runner agent, registered
to this repository with the labels `prime-linux-x64` and `prime-linux-arm64`.
The macOS legs stay on GitHub's runners. This document is the contract the
workflow changes rely on: what the runner host is, how it is provisioned and
teared down, what the labels guarantee, and the operational rules that keep
the queues healthy.

## Scope

| Workload | Runs on |
| - | - |
| `continuous.yml` → `build-gnu` (x86_64 + aarch64) | `prime-linux-x64`, `prime-linux-arm64` |
| `release.yml` → `build-gnu` (x86_64 + aarch64) | same labels |
| `continuous.yml` → `build-darwin`, `release.yml` → `build-darwin` | GitHub-hosted (unchanged) |
| `deny`, `staleness`, `tag-check`, `reuse-continuous`, `promote`, `nightly-refresh` | GitHub-hosted (unchanged) |
| `ci.yml` (PR + merge gates) | GitHub-hosted, out of scope for this change |

The `ci.yml` PR gates never run on these runners: PR code runs only on
GitHub-hosted machines. The sandbox runners execute code that is already
merged to `main` (continuous) or tagged (release).

## The runner host

A runner is a Prime sandbox VM (the `vm` runtime; the sandbox SDK always
boots VMs). The VM boots the OCI image `ubuntu:22.04@sha256:b8b6ee6…` as its
root filesystem — the same digest-pinned multi-arch image the old
`container:` stanza pulled on GitHub's runners. The GLIBC 2.35 build
baseline therefore moves with the runner provision, not with the job: the
`GLIBC_2.35` gate in the workflow keeps proving it, and the runner rootfs
is pinned by the same reviewed digest.

Reference size: 4 vCPU, 8 GiB RAM, 30 GiB disk. There is no Docker inside
the VM and none is needed — the workflow builds directly in the runner
rootfs.

The warm-build contract: the runner VM persists `target/` (and the rustup
toolchain) across builds. That is why the self-hosted legs carry no
`Swatinem/rust-cache`: the disk is the cache, and a stale restored tarball
over a warm target dir would only regress cargo fingerprints. The jobs check
out with `clean: false` (the default `git clean -ffdx` would delete
`target/`), then clean everything except `target/` and delete the previous
run's `dist/` and `catalog-assets/` outputs. A freshly provisioned runner
pays one cold build; every build after that is warm.

## Labels and the two Linux legs

- `prime-linux-x64` — builds `x86_64-unknown-linux-gnu`, natively on the
  x86_64 VM.
- `prime-linux-arm64` — builds `aarch64-unknown-linux-gnu`. The Prime
  sandbox fleet is x86_64-only today, so this leg cross-compiles on the x64
  host: the GNU `aarch64-linux-gnu` toolchain links against the Ubuntu
  22.04 cross sysroot (the same GLIBC 2.35 baseline), and every gate still
  runs:
  - the GLIBC gate reads the arm64 ELF with `aarch64-linux-gnu-objdump`;
  - the livechecks execute the produced arm64 binary on the x64 host under
    `qemu-user` binfmt (`QEMU_LD_PREFIX=/usr/aarch64-linux-gnu` points qemu
    at the cross sysroot's dynamic linker);
  - the assembly steps are arch-neutral Python.

  When Prime ships arm64 sandbox hosts, this leg can move to a native arm64
  runner (swap the cross toolchain row for a native build) with no workflow
  shape change.

## Provisioning

The in-sandbox half is `scripts/ci/register_runner.sh`. It runs once per
provision as root and:

1. creates a locked, sudo-less `gh-runner` user — the agent refuses to run
   as root, and the user is the boundary between job code and the provision
   layer;
2. installs everything the jobs need, because job steps cannot use root:
   the native build tools, the aarch64 cross toolchain, and qemu-user, and
   enables the `qemu-aarch64` binfmt handler (every runner gets the full
   set, so any runner can take either label). The workflow's first step
   only checks that these are present;
3. downloads the pinned runner tarball (v2.337.0, sha256-verified);
4. runs `config.sh --unattended` with a fresh registration token and the
   runner's labels;
5. starts the agent under a restart-on-exit supervision loop (sandboxes
   have no systemd).

The registration token is a one-hour credential minted per provision:

```
gh api -X POST repos/PrimeIntellect-ai/prime-agent/actions/runners/registration-token
```

The runners are repository-scoped on purpose: they build release artifacts
and keep their workspace between jobs, so no other repository may run jobs
on them. Registering at the org level is only safe inside a runner group
that is limited to `prime-agent`.

The token is passed to the fleet driver as a sandbox *secret* (encrypted at
rest, materialized as an env var inside the VM, never logged, never in an
API response), reaches `register_runner.sh` as `$RUNNER_TOKEN`, and crosses
as argv (briefly visible via `ps` to root and the runner user during
registration) - to the register script and `config.sh`, and never as an
interpolated shell string.

The sandbox-SDK half (create the VM, inject the secret, upload and run the
script, keep the VM alive, delete it at teardown or on the 7-day sandbox
lifetime cap) lives in the fleet tools, not in this repo.

## Security model

GitHub warns against self-hosted runners on public repos because a runner
executes workflow code on your infra. This design answers each half:

- **What code runs here**: our workflows send only `main` pushes
  (continuous) and tags (release) to these labels, and the PR wave
  (`ci.yml`) stays on GitHub-hosted runners. GitHub does not enforce this
  for repository runners: a workflow edited in a branch or a pull request
  (once its run is approved) can target the labels too. Keep fork pull
  request runs behind approval, or register the runners in an org runner
  group limited to this repository and to the `continuous.yml` and
  `release.yml` workflows. The build jobs hold no secrets:
  `permissions: contents: read`, and every publish credential (R2 keys, the
  release environment) stays on the GitHub-hosted `promote` job.
- **What the code can touch**: the runner VM, as the sudo-less `gh-runner`
  user. The VM and its `target/` cache live until the weekly rotation, so a
  job that tampers with the cache can affect the artifacts of later builds
  on that runner until it is re-created. Egress can be narrowed with the
  sandbox network allowlist (GitHub endpoints + crates.io).
- **What it costs to be wrong**: a runner VM can be deleted and re-created
  in seconds from the pinned image; the registration is a one-script
  provision.

## Operations

- **Bring-up**: mint a registration token → fleet driver creates the VM
  with the token as a secret → `register_runner.sh` registers and starts
  the agent → the runner appears *Idle* in the GitHub runner list within a
  minute. Repeat per label (`prime-linux-x64`, `prime-linux-arm64`).
- **Keep-alive / rotation**: the sandbox lifetime cap forces a weekly
  recreate; the driver deletes the old VM and provisions a fresh one with a
  fresh token. Deleting the VM does not deregister the runner: the dead
  registration stays listed *Offline* until it is removed (manually, or by
  GitHub after >14 days disconnected). The runner name is hostname-derived,
  so the fresh VM can receive the same name as the lingering entry;
  `register_runner.sh` passes `--replace`, and the fresh registration takes
  the name over if that happens instead of failing. The first build after
  each rotation is cold.
- **Teardown**: delete the VM; remove the dead runner entry
  (`gh api -X DELETE repos/PrimeIntellect-ai/prime-agent/actions/runners/<id>`)
  at the next convenience.
- **Monitoring**: a runner that stops polling shows *Offline* in the runner
  list; a job stuck in *Queued* with no *Idle* runner for its label means
  the fleet is down. The supervision loop logs exits to
  `runner-supervisor.log` in the runner directory.
- **Fallback**: the labels are the only coupling. If the fleet is down,
  moving the two matrix rows back to `ubuntu-24.04` / `ubuntu-24.04-arm`
  (and restoring the `container:` stanza from git history) puts the Linux
  legs on GitHub's runners again.

## Cost and speed

GitHub-hosted runners are free for this public repo, so the win is latency
and queueing, not billing; the sandbox pair bills as always-on compute at
the platform's published rates (CPU $0.02/vCPU-h, memory $0.0125/GiB-h,
disk $0.0002/GiB-h). A 4 vCPU / 8 GiB / 30 GiB pair costs ≈ $0.19/h ≈
$4.5/day ≈ $134/month per runner; a per-build ephemeral runner pays only
for its ~5-7 minutes per leg (a few cents) but rebuilds cold every
time. The persistent pair is the recommended default: the measured release
build on a 4 vCPU runner is ~190-205 s warm and ~235-250 s cold (a ~4-6
minute leg end to end), versus 6-20 minutes per Linux leg on GitHub's
2-core runners — and the continuous concurrency
group serializes runs, so every minute saved per leg drains the merge
queue that much faster. The detailed measurements and the persistent-vs-
ephemeral trade live in the fleet's report for this change.
