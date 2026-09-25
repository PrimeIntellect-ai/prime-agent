# Installer + CI/CD hardening — design

Status: **approved by orchestrator 2026-09-17** — implementation in progress.
Owner lane: `lane/installer-ci`. Scope: release pipeline, artifact shape, Homebrew
compatibility, CI/CD hardening, local gates.

## 1. Scope and non-goals

In scope:

- Build matrix -> artifact assembly -> SBOM/provenance -> promotion gate -> release attach.
- Stable, versioned, checksummed tarballs with a predictable layout, including the bundled
  kernel runtime sidecar.
- Homebrew cask/formula sketch with a clean uninstall story.
- Publish/build separation and the GitHub token model.
- Committed workflow files + local `make` gates that mirror them (see §3).

Non-goals (tracked elsewhere):

- Porting the TS `install.sh` self-update flow (`~/.local/share/prime-agent/releases/...`,
  `.install-source`, `.archive-sha256`, self-update commands). That is a separate installer
  lane; this design keeps the artifact manifest TS-installer-compatible so the port is a drop-in.
- Apple notarization (explicitly deferred by the operator; the workflow reserves the step).
- Windows release builds (matrix reserved in the workflow; shipped when the platform traits land).
- crates.io/npm publishing (nothing here publishes to a registry; "publishing" = GitHub release).

## 2. Ground truth and current state

TS release pipeline (reference, `~/prime-agent/scripts/*`):

- `releasePlatforms`: darwin-arm64/x64, linux-arm64/x64 (+ musl/baseline variants).
- `assemble-release-archives.mjs`: stages `prime-agent` + `binaryAssets`
  (`prime-agent-runtime`, `skills`, `theme`, `assets`, `docs`, `examples`, LICENSE, ...)
  into a staging dir, writes `prime-agent-<version>-<platform>.tar.gz` (files at the tarball
  root), emits `SHA256SUMS` + `binaries.json` (per-archive sha256 + executable sha256).
- Archives are uploaded to an R2 bucket; `install.sh` extracts into
  `~/.local/share/prime-agent/releases/<version>-<platform>-<archive-sha256>/` and symlinks
  `~/.local/bin/prime-agent` to the release binary.
- The compiled binary resolves its package dir as `dirname(execPath)` (PI_PACKAGE_DIR
  override wins) — the runtime and skills live **next to the binary**.

Rust rewrite state:

- `pa-core` already resolves the package dir the same way
  (`crates/pa-core/src/kernel/bootstrap.rs::package_dir`, `crates/pa-core/src/packages/mod.rs`):
  `PI_PACKAGE_DIR` wins, then the exe directory. A tarball that puts `prime-agent` and
  `prime-agent-runtime/` in one directory is therefore self-contained — **no PI_PACKAGE_DIR
  dependency in shipped artifacts** (the env var stays a dev/Nix escape hatch, TS parity).
- `--version` prints `CARGO_PKG_VERSION` (`pa-cli/src/config.rs::VERSION`), workspace version
  from `Cargo.toml [workspace.package]` — single source of truth for releases.
- `Cargo.lock` is committed; the workspace pins `profile.release` (thin LTO, symbols kept).
- The kernel needs `uv` on PATH or `~/.local/bin/uv` (the binary never auto-installs it) to
  bootstrap the kernel venv from the bundled runtime sources.
- Coordination: the kernel-packaging lane vendors `prime-agent-runtime/` at the repo root
  (branch `lane/kernel-packaging`, commit "kernel: vendor the prime-agent-runtime sidecar").
  The assembly step bundles `<repo>/prime-agent-runtime/` into every tarball. Until that PR
  merges, the assembly script takes an explicit `--runtime-dir` (the local gate points at the
  kernel-packaging worktree); after the merge the default path just works.

## 3. Operational constraint (workflow scope)

The GitHub token on this box lacks the `workflow` scope. Therefore:

- The workflows land as **committed files, byte-identical to their final form, staged at
  `ci/workflows/`** — neither this lane's token nor the orchestrator's can push or merge
  anything under `.github/workflows/` without `workflow` scope (pushes are rejected with
  `refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope`;
  the same operational constraint PR #76 documented; re-verified 2026-09-21 — Kevin's new
  workflow-scoped token lives on HIS Mac, not on this box). Activation is the operator step
  `make activate-workflows` (ci/workflows/README.md): run from a machine whose push
  credential has the scope, it moves `continuous.yml` + `release.yml` to `.github/workflows/`
  and pushes main. Pasting the staged files through the GitHub web UI is the
  scope-free equivalent.
- Until promotion the workflows do not execute on GitHub; CI is enforced **locally**
  via `make` gates that run the exact same steps the workflows define.
- Every workflow step has a 1:1 local target (§9). When scope is granted, the promotion move
  is the only change — no workflow content edits are needed.

## 4. Release pipeline

```
 push PR / push main
   ┌────────────────────────────────────────────────────────────────────┐
   │ ci.yml                                                             │
   │   fmt --check | clippy -D warnings | cargo test --workspace         │
   │   cargo-deny (advisories + licenses)                                │
   │   permissions: contents: read only. persist-credentials: false.     │
   └────────────────────────────────────────────────────────────────────┘

 push tag v<x.y.z>
   ┌────────────────────────────────────────────────────────────────────┐
   │ tag-check (release.yml)                                             │
   │   ref is a tag; tag name == [workspace.package] version            │
   │   prerelease (if any) starts with -beta (the publishable channels)  │
   │   clean worktree; permissions: contents: read                      │
   └───────┬────────────────────────────────────────────────────────────┘
           ▼
   build matrix (needs: tag-check; permissions: contents: read; no secrets)
   ├── x86_64-unknown-linux-gnu   (ubuntu-24.04 host, ubuntu:22.04 container)
   ├── aarch64-unknown-linux-gnu  (ubuntu-24.04-arm host, ubuntu:22.04 container, native)
   ├── aarch64-apple-darwin       (macos-14)
   └── x86_64-apple-darwin         (macos-13)
   GNU targets additionally gate on the GLIBC baseline (see §10).
   per target:
     cargo build --release --target <t>  (committed Cargo.lock, -D warnings)
     ./<t>/release/prime-agent --version  == tag version      (livecheck gate)
     scripts/release/assemble_artifacts.py --target <t> --version <ver>
       -> staging: prime-agent + prime-agent-runtime/ + skills/ + docs/ + LICENSE + README.md
       -> prime-agent-<ver>-<platform>.tar.gz (files at tarball root, deterministic tar;
          the platform alias — see §5 naming — not the target triple)
       -> per-target SHA256SUMS + manifest entry (archive sha256 + executable sha256)
     upload artifact (tarball + checksums + manifest)
           ▼
   promotion (needs: all build jobs; environment: `release`, protection rules on)
     permissions: contents: write, id-token: write; everything else none
     downloads build artifacts only — never checks out source into the same
       step that writes, never rebuilds, receives no registry tokens
     verifies each artifact's sha256 against the manifest the build jobs produced
       (build-to-publish hash continuity — a tampered upload fails here)
     generates SPDX SBOM (syft) per tarball from the unpacked staging tree
     creates artifact attestations (actions/attest-build-provenance@v2, SLSA)
     [reserved: Apple notarization — gated on certs landing]
     emits the channel manifest (the update flow's producer; see §5):
       latest.json for a plain vX.Y.Z tag (stable), beta.json for a
       -beta* prerelease tag (nightly) — byte-compatible with
       pa-core::update::release::latest_release, hard-failing on any row
       the reader would reject
     creates the GitHub release v<ver> and attaches:
       prime-agent-<ver>-<platform>.tar.gz (4)
       SHA256SUMS (all targets), manifest.json (TS-installer-compatible)
       latest.json|beta.json (the channel manifest), sbom-spdx-<ver>-<t>.json (4)
```

PR builds never reach the promotion stage: `ci.yml` has `contents: read` only, and the
release workflow triggers exclusively on `vX.Y.Z` (stable) and `vX.Y.Z-beta*` (nightly)
tags. The tag itself is the release gate;
environment protection rules (required reviewers, tag-pattern restriction) are configured
once by the operator in repo settings.

## 5. Artifact layout

One tarball per target, files at the tarball root (TS parity — the TS installer and our
future install.sh port both expect that):

```
prime-agent-<version>-<platform>.tar.gz
├── prime-agent              # the release binary (exec bit set)
├── models.bundled.json      # bundled catalog assets (catalog spec §3.2 layer 2:
│                            # generated at build time, never committed; the
│                            # runtime's no-cold-start chain serves them beside
│                            # the executable)
├── mcp-services.bundled.json
├── prime-agent-runtime/     # Python kernel sidecar (pyproject.toml, src/rlm, uv.lock)
├── skills/                  # bundled built-in skills (repo `skills/`)
├── docs/                    # product docs (package-dir `docs_path()`)
├── LICENSE
└── README.md
```

Bundled catalog assets: `scripts/release/bundle_catalog.py` generates them
right before assembly. CI uses the offline `--fixture` snapshot (builds never
depend on the catalog repo being reachable; it still passes the full
validation gates — models `schemaVersion == 1` with ≥ 42 distinct
`(provider, api, baseUrl)` transport tuples, plugins `version == 2` with
≥ 68 services). The live fetch (`--network`) and a local catalog checkout
(`--catalog-dir`) exist for packaging parity and catalog maintenance. The
packer (`assemble_artifacts.py`, `package_release.py`) and the verifier
(`verify_release.py`) share the same validation functions and hard-fail
without validated assets.

Naming: `prime-agent-<version>-<platform>.tar.gz`, e.g. `prime-agent-0.1.0-darwin-arm64.tar.gz`
— the TS platform alias (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`), TS
`assemble-release-archives.mjs` parity. The alias is not cosmetic: the update flow's channel
manifest is the download contract, and `pa-core::update::release` keeps an artifact row only
when `file` is exactly `prime-agent-<version>-<platform>.tar.gz`; the target triple stays in
`manifest.json`'s `target` field (CI matrix keys, SBOM directories, Homebrew arch stanzas
map 1:1 from the alias).

Determinism: tar with fixed uid/gid 0, numeric owner, name-sorted entries, fixed mtime
(GNU tar on Linux; bsdtar equivalents on macOS; `COPYFILE_DISABLE=1` on macOS to keep
`._*` AppleDouble files out of the archives — same trick the TS assembler uses).

Install layout after extraction (documented for the install.sh lane): the tarball extracts
into `~/.local/share/prime-agent/releases/<version>-<platform>-<archive-sha256>/` with the
symlink flip the TS installer performs; the shipped artifact itself never needs
`PI_PACKAGE_DIR`.

Livecheck contract: `prime-agent --version` prints the bare semver, and release assets follow
the stable URL `https://github.com/<org>/<repo>/releases/download/v<ver>/prime-agent-<ver>-<platform>.tar.gz`.

### 5a. Channel manifests (latest.json / beta.json)

The update flow's read side (`pa-core::update::release::latest_release`, the TS
`getLatestPiRelease` port) resolves its channel from the running version
(`resolve_update_channel`: a `-beta*` prerelease is nightly, anything else is stable) and
fetches `<download-base>/latest.json` (stable) or `<download-base>/beta.json` (nightly) from
the release download base. The release workflow is the producer: the promote job emits
exactly one channel manifest per tag —

- a plain `vX.Y.Z` tag publishes `latest.json` (the stable channel);
- a `vX.Y.Z-beta.N` tag publishes `beta.json` (the nightly channel); any other prerelease
  is refused at tag-check (the read side would treat it as a stable-channel pre-release and
  skip it); the nightly release attaches as a GitHub **prerelease** so it never takes the
  Latest pointer — the stable channel's download base
  `.../releases/latest/download/` keeps serving the latest stable release's
  `latest.json` (Bugbot: beta tags steal GitHub Latest), and every -beta* tag
  also refreshes the rolling `nightly` release (the documented
  continuous-release pattern): `.../releases/download/nightly/` is the stable
  base nightly installs record (`.install-source`) and resolve `beta.json` +
  its archives against — GitHub's `latest/download/` alias structurally
  serves only the latest non-prerelease release, so the nightly channel has
  no discoverable address there (Bugbot: nightly clients get a 404). Every
  tag promotes under its own concurrency group (no queued promotion is ever
  canceled); the refresh itself is the `nightly-refresh` job, serialized in
  its own `rolling-nightly-refresh` group, and it refuses to clobber a newer
  rolling `beta.json` (newest-wins), so the rolling release always serves
  the newest completed beta (an older run must never overwrite the newest
  one);

shaped as `{"version": "v<ver>", "binaries": [...], "binaries_v2": [...]}` where each row is
`{"platform", "file", "sha256"}` and the file names are the alias-named archives above. The
v1 `binaries` list stays limited to the original installer platforms (TS `manifestV1Platforms`
parity); `binaries_v2` carries every row, and the reader skips platforms it does not know.
The emission hard-fails on any row the reader would reject (wrong file name, bad sha256,
duplicate platform) — a lying manifest is worse than none — and
`crates/pa-core/tests/release_channel_manifest.rs` pins the producer against the exact reader
by running the workflow's real step code over fixture trees.

## 6. Token model and publish/build separation

- PR builds: the ephemeral job token with `contents: read` only; `persist-credentials: false`
  on checkout; no environment secrets. Third-party actions pinned by commit SHA.
- Build jobs (release): same — `contents: read`, **no** release credentials, **no** publish
  capability. They produce artifacts and checksums, nothing else.
- Promotion job: runs in the protected `release` environment, holds `contents: write`
  (GitHub release attach) and `id-token: write` (artifact attestations). It consumes only
  the uploaded artifacts and their manifests; there is no path from PR code to a release
  without a maintainer tag + environment approval.
- There are no other publish tokens in this design (no registry publishing). Any future
  publish target inherits the same separation: tokens live only in the promotion
  environment, which never builds.

## 7. Supply chain

- **Committed `Cargo.lock`** (already true) — releases build exactly what was reviewed;
  the tag-check job additionally fails if the lockfile is dirty after `--locked` builds.
- **cargo-deny** (`deny.toml`): advisories (fail on RLSA/vulnerabilities) + licenses
  (allowlist derived from the actual `Cargo.lock` license set; denied-by-default). Runs in
  `ci.yml` on every PR and locally via `make deny`. Unpatched/unmaintained advisories are
  not silenced silently: each carries an `ignore` entry with the triage reason and review
  date, and is removed as soon as upstream fixes land or the dependency is dropped.
  Current triage: RUSTSEC-2023-0071 (`rsa` — unpatched upstream; declared but unused by
  pa-ai, so no timing oracle executes) and RUSTSEC-2024-0436 (`paste` — unmaintained
  proc-macro via ratatui, build-time only).
- **SBOM**: SPDX JSON per target, generated in the promotion job from the unpacked artifact
  (syft over the staging tree), attached to the release. The SBOM covers the binary's crate
  graph plus the bundled runtime/skills tree.
- **Provenance**: `actions/attest-build-provenance@v2` (SLSA v3, sigstore) over each tarball
  and the inner binary, using the promotion job's `id-token: write`. Hash continuity is
  verified before attestation: the promotion job recomputes every artifact's sha256 and
  compares it to the build job manifest.
- **Signed artifacts**: artifact attestations are the signing mechanism in v1 (no key
  management). SHA256SUMS + manifest.json give consumers an out-of-band integrity check;
  Homebrew consumers verify the in-cask `sha256` stanzas. Apple notarization + a Developer
  ID signing step are reserved slots.
- **`cargo auditable`** embedding is a local-gate option (`make audit-build`) that records the
  dependency list inside the binary for incident response; enable in CI after a release
  baseline exists.

## 8. Homebrew compatibility

Cask (preferred — we ship a prebuilt binary bundle; the zap stanza needs cask semantics):

```ruby
cask "prime-agent" do
  version "0.1.0"
  sha256 arm:   "<sha>",
         x86_64: "<sha>"

  on_arm do
    url "https://github.com/kevinjosethomas/prime-agent-rs/releases/download/v#{version}/prime-agent-#{version}-darwin-arm64.tar.gz"
  end
  on_intel do
    url "https://github.com/kevinjosethomas/prime-agent-rs/releases/download/v#{version}/prime-agent-#{version}-darwin-x64.tar.gz"
  end

  name "Prime Agent"
  desc "RLM agent harness (Rust rewrite)"
  homepage "https://github.com/kevinjosethomas/prime-agent-rs"

  livecheck do
    url :url
    regex(/prime-agent-v?(\d+(?:\.\d+)*)-darwin-arm64\.tar\.gz/i)
  end

  binary "prime-agent"   # symlink resolves through to the caskroom dir,
                         # where prime-agent-runtime/ sits next to the binary

  zap trash: [
    "~/.prime",          # sessions, subagents, skills, harness state, kernel venvs
  ]
end
```

Why `binary "prime-agent"` works with the bundled runtime: the binary resolves its package
dir from the **real** executable path (symlinks are resolved by `current_exe()` on both
platforms), which is the caskroom directory containing `prime-agent-runtime/` and `skills/`.
This is the exact mechanism the TS binary uses on this box
(`/usr/local/bin/prime-agent -> ~/.local/bin/prime-agent -> releases/.../prime-agent`).

Formula alternative (if we ever want `brew install` to manage the runtime deps):

```ruby
class PrimeAgent < Formula
  version "0.1.0"
  depends_on "uv" => :recommended   # kernel venv bootstrapping (binary looks for uv on PATH)
  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"prime-agent"
  end
  test do
    assert_match version.to_s, shell_output("#{bin}/prime-agent --version")
  end
end
```

Unmanaged runtime deps: `uv` is the only external tool the shipped artifact invokes, and it
is only needed when a kernel venv must be (re)bootstrapped. The cask documents the
`brew install uv` prerequisite in `desc`/notes; the formula declares it. The kernel venv and
`~/.prime` data are user state, covered by `zap`.

Homebrew consumers never need `PI_PACKAGE_DIR`; the caskroom layout is the packaged-bundle
layout.

## 9. Local gates (mirror of CI, usable today)

New Makefile targets (existing `make check` unchanged):

- `make deny` — `cargo deny --workspace check advisories licenses` (fails loudly if
  cargo-deny is not installed).
- `make actionlint` — validates the committed workflow files (fails loudly if actionlint
  is missing).
- `make continuous-dry-run [RUNTIME_DIR=<path>]` — the continuous-channel mirror:
  `--sha HEAD` stamping, the `package.json` payload entry, and the
  `<version>-continuous.<sha>` livecheck (`continuous.yml` build job).
- `make release-dry-run [RUNTIME_DIR=<path>] [VERSION=<x.y.z>]` — the release verifier,
  host-only:
  1. `cargo build --release --locked` (workspace version vs requested version asserted).
  2. Generate the bundled catalog assets (offline `--fixture`, the same mode
     the CI build jobs use; `CATALOG_ASSETS_MODE=network` switches to the
     live-catalog fetch).
  3. Assemble the host-target tarball via the same `scripts/release/assemble_artifacts.py`
     the CI build jobs run (deterministic tar, checksums, manifest); assembly
     hard-fails without validated catalog assets.
  4. Verify, from a scratch cwd with `PI_PACKAGE_DIR` **unset**: staged `prime-agent
     --version` == workspace version; tar listing matches §5 exactly; the
     extracted tarball carries both validated catalog assets.
  5. Recompute the archive sha256 and diff against SHA256SUMS.
- `make catalog-assets` — generate the bundled catalog assets from the live
  catalog repo (network fetch); `make catalog-assets-fixture` — the offline
  synthetic snapshot the CI build jobs use; `make catalog-assets-gates` — the bundler/packer test
  battery (`scripts/release/test_catalog_assets.py`): the fixture passes the
  full validation gates, the packer hard-fails on missing/invalid assets,
  the network mode is verified against a local HTTP server, and the assets
  land in the tarball layout the installer expects.
- `make audit-build` — release build through `cargo auditable` (optional hardening).

Verifier for the lane (objective, runs on this box): `make release-dry-run RUNTIME_DIR=<kernel-packaging
worktree>/prime-agent-runtime` passes end-to-end, plus `make check`, `make deny`, and
`make actionlint` all green. After kernel-packaging merges, the same command with no
`RUNTIME_DIR` also passes.

TODO (once kernel-packaging lands): `make release-dry-run` must additionally boot a
session from the unpacked tarball with `PI_PACKAGE_DIR` unset — the bundled kernel
runtime sidecar has to satisfy the binary's package-dir resolution on its own (the
same mechanism Homebrew's `binary` stanza relies on). The gate becomes: extract the
dry-run tarball to a scratch dir, run `prime-agent` with the REPL kernel, assert the
kernel session boots without the env override.

## 10. Matrix plan and Windows readiness

| target | runner | status |
|---|---|---|
| x86_64-unknown-linux-gnu | ubuntu-24.04 host + `ubuntu:22.04` job container | now |
| aarch64-unknown-linux-gnu | ubuntu-24.04-arm host + `ubuntu:22.04` job container (native) | now |
| aarch64-apple-darwin | macos-14 (native arm64) | now |
| x86_64-apple-darwin | macos-13 (native x64) | now |
| x86_64-pc-windows-msvc | windows-2022 | reserved, commented entry; shipped when the Windows trait impls land |

All four current targets build natively (no cross toolchains, no qemu). musl/baseline
variants (TS ships them for Bun-specific CPU features) are unnecessary for the Rust binary;
if a static-linked Linux target is wanted later it slots in as another matrix entry.

**GNU/Linux release baseline: Ubuntu 22.04 (glibc 2.35).** Both GNU targets build
inside an `ubuntu:22.04` job container so the linked glibc never exceeds the baseline —
building on the ubuntu-24.04 runner image produced binaries that require GLIBC_2.39 and
do not start on Ubuntu 22.04 (verified 2026-09-24 on a deploy box). The container image is
multi-arch, so aarch64 remains a native build (the host runner only supplies CPU). A
post-build gate in `continuous.yml` and `release.yml` fails the build when the binary
requires any symbol above `GLIBC_2.35`; the release livecheck runs inside the same
container, so every GNU release binary is proven to start on 22.04 before promotion.

## 11. Implementation plan (on approval)

| file | purpose |
|---|---|
| `docs/installer-ci-design.md` | this document |
| `ci/workflows/ci.yml` | PR/push gates (fmt/clippy/test/deny), read-only; promoted to `.github/workflows/` on scope grant |
| `ci/workflows/release.yml` | tag-check -> build matrix -> promotion -> release attach; activated via `make activate-workflows` |
| `ci/workflows/continuous.yml` | rolling `continuous` release on every push to main (§13); activated via `make activate-workflows` |
| `deny.toml` | cargo-deny advisories + license allowlist |
| `scripts/release/assemble_artifacts.py` | staging + deterministic tar + SHA256SUMS + manifest (TS-parity manifest fields) |
| `packaging/homebrew/Casks/prime-agent.rb` | cask sketch (living draft until we have a tap) |
| `packaging/homebrew/Formula/prime-agent.rb` | formula alternative sketch |
| `Makefile` | `deny`, `actionlint`, `release-dry-run`, `audit-build` targets |

Nothing in the plan touches crate internals or `Cargo.toml` dependency direction. The
workflows are written to be valid now (pinned action SHAs, `make actionlint` green) and
inert until they are promoted to `.github/workflows/` and Actions is enabled.

## 12. Review decisions (orchestrator, 2026-09-17) and open items

Decided at design review:

1. **Cask preferred** (matches the operator directive's stable-URL + zap-stanza shape);
   the formula sketch is kept alongside in `packaging/homebrew/`.
2. **skills/ bundle**: the assembler packages the repo-state `skills/` at tag time.
   The lane rebases onto branding-scrub's PR if it lands first so shipped skills carry
   the scrub.
3. **Changelog automation deferred** (v1 releases have no `.changes` fragment flow).

Open items (operator decisions, non-blocking):

1. **Repository publicity / Homebrew channel**: tarballs say `prime-agent`, the repo is
   `prime-agent-rs` under `kevinjosethomas`. The cask URLs use the repo's real name, but
   a cask is only usable once the repo is public or a token-authenticated tap exists.
   Which channel ships releases is an operator decision; nothing in this design blocks
   on it.
2. **Notarization** (already non-goal v1): the workflow reserves the step; cert landing
   is an operator dependency.

## 13. Continuous channel (rolling prebuilt binaries for coworkers)

`ci/workflows/continuous.yml` (staged, same promotion constraint as §3) is the
coworker-sharing channel Kevin asked for (2026-09-21): a compiled install for
every push to `main`.

- Trigger: pushes to `main` only (never tags, never PRs); `concurrency`
  cancels superseded builds.
- Build job: the same 4-target matrix as the release pipeline
  (`cargo build --release --locked`, assembler, artifact upload), with the
  commit stamped via `assemble_artifacts.py --sha ${GITHUB_SHA}`: the tarball
  carries a `package.json` manifest whose `version` is
  `<workspace-version>-continuous.<sha>`, so `prime-agent --version` reports
  the exact commit. The archive names keep the bare version so the rolling
  release overwrites assets in place; a workspace version bump renames them
  (the publish job drops the stale names).
- Publish job: `contents: write` only (no environment, no secrets beyond the
  job token); verifies build-to-publish hash continuity, merges the per-target
  `SHA256SUMS`/`manifest.json`, force-moves the `continuous` tag to the
  triggering commit, and republishes via `softprops/action-gh-release@v2` with
  `make_latest: false`, `prerelease: true`, and a "Built from `<sha>` —
  `<subject>`" body.
- Supply chain: the SBOM/attestation gates stay on the tag pipeline (§7);
  the continuous channel is a convenience channel, not the release authority.
- Local mirror: `make continuous-dry-run`.
- Consumer docs: README.md "Continuous builds" (per-platform install
  one-liners). Note the `macos-13` Intel runner label was retired by GitHub;
  both workflows use `macos-15-intel` for `x86_64-apple-darwin` now.
- Activation (operator step, after the lane merges): `make activate-workflows`
  from a workflow-scoped machine (Kevin's Mac) moves the file to
  `.github/workflows/continuous.yml` and pushes main. Post-activation
  verification: `gh workflow list --repo PrimeIntellect-ai/prime-agent`
  shows `continuous` (and `release`) active; the next push to `main` publishes
  the first `continuous` release.
