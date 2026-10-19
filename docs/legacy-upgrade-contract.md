# Legacy TypeScript upgrade contract

This audit covers published Prime Agent releases from v0.6.0 onward, including
18 stable TypeScript releases through v0.9.8 and relevant candidate and beta
artifacts. Earlier versions are excluded from the requested support scope.
Inventory and source comparison are not evidence that an installed-artifact
upgrade or every supported platform has passed testing.

## Published inventory in scope

A full two-page GitHub Releases API query on 2026-10-09 returned 107 releases.
The compact [release inventory](legacy-release-inventory.json) records the 18
stable releases in scope, independent GitHub npm-asset digests, source targets,
and relevant TS prereleases. The stable versions are 0.6.0–0.6.1,
0.7.0–0.7.4, 0.8.0–0.8.1, and 0.9.0–0.9.8.

All 18 have genuine published `prime-agent-VERSION.tgz` assets; this inventory
does not count inherited upstream Git tags as Prime releases. The unscoped
public npm registry endpoint for `prime-agent` returned 404 during this audit;
these npm packages are published as tarballs through GitHub and the release bucket.

Additional published TS artifacts are `0.9.1-fhcache1` (the same digest hosted by
both `fhcache-candidate-1` and `releases/v0.9.1-fhcache1`) and the rolling `beta`
release, currently `0.9.8-beta.2286.1.7d442aa`. The latter has npm and native
archives. The fhcache package digest, independently supplied by the GitHub API,
is `4a461bf7fc9d8e6e4e61471b66341aff05ba94e02c6c25f678851d26d1b27d2c`.
It has no published SHA256SUMS file. A locally computed digest alone is not
independent download verification.

The 49 versioned Rust `0.9.9-beta.*` releases are distinct from TS migration
fixtures and require Rust-to-Rust update coverage. Their exact published tags
are recorded in the inventory. The `nightly` release is a rolling Rust asset host.
Historical rolling TS beta assets are overwritten on GitHub; this inventory
cannot establish an exhaustive list of every beta ever distributed through the
bucket. Do not equate an absent GitHub beta tag with an unpublished build.

## Authoritative release sources

Use the GitHub release `target_commitish` below for source comparisons of the
audited versions, then verify behavior against the actual published artifacts.
Several local version tags resolve to upstream history with different package
names and no Prime Agent updater. Those tags are not suitable fixtures for these
releases. A recorded source target alone does not prove the bytes shipped; release
assets remain the authoritative end-to-end test inputs.

| Release | GitHub release target commit |
| --- | --- |
| v0.6.0 | `7db7b69c60be0f7b271faf948864891813b27182` |
| v0.6.1 | `8bd7c18f16bfdc356c1cd20fb9fcf01119147cda` |
| v0.7.0 | `be9e2fa0714e7cd1c6bd9bdb1b554d2cc6550387` |
| v0.7.1 | `95afd319a78ae017a41241d50b013d656a0685ce` |
| v0.7.2 | `83a0f9f9566219551fcb6ffaf7f519a815749a58` |
| v0.7.3 | `61131b2d195ba7a67a4ce8ac60bb10cecae07b67` |
| v0.7.4 | `af0b8e00b9f704e834787fd321065ca78281f2aa` |
| v0.8.0 | `8d7deeab5861bf9d77bde3d8511046a5c799818d` |
| v0.8.1 | `514633727bf26d74f39f3119c2b0e31a5ceb2a9d` |
| v0.9.0 | `c394506e2f0dd887b3f94908da9f2910b43c846b` |
| v0.9.1 | `81ae3cb34d27d38ee37f9e205a1e73694993b344` |
| v0.9.2 | `9c54a35dac3a2ad17910074d66664859ea175666` |
| v0.9.3 | `915c78f42c248b08238dd27fcd4bcab32c60beab` |
| v0.9.4 | `f771dfcedd684d1afff84ca2c6fa95c7a21efbc2` |
| v0.9.5 | `a7d791bc1be09793ed5f3ec05bf4cccbc60679ea` |
| v0.9.6 | `e260085dd8f742e0def3d871860c9a888b114851` |
| v0.9.7 | `08ff1b2e2794ea9e8f4a08d12bc95408a66e1074` |
| v0.9.8 | `7d442aafa985f9342134fac16c2ef41f03fb45c1` |

## Update families

- v0.6.0–v0.9.4 ship npm tarballs. Their
  `packages/coding-agent/src/utils/version-check.ts` files are byte-identical:
  SHA-256 `5a87851fc4f6473452607cb2816945e82f37e35f3aa2ecc846b3d41f1932aa29`.
- v0.9.5–v0.9.8 additionally ship managed native archives. Their manifest parsers
  are byte-identical: SHA-256
  `2a37f5116a6d855da564bb3efe4a6b62eb0d0a35523c369796b5529379dacff0`.
  Their `cli/native-update.ts` files are also byte-identical: SHA-256
  `707cdc796f035f01c08647c026a1f1a5aaeafbb3b4158a22e741b367a8d10f03`.

All stable clients read `latest.json` under `PRIME_AGENT_DOWNLOAD_BASE_URL`, or
the default release bucket. Beta clients read `beta.json`. The parser accepts
`version`, `package` (or `packageName`), and `tarball`; relative tarball URLs
resolve against the release bucket. Keep the npm tarball in the manifest even
when native artifacts are present.

## npm bridge requirements

The published package builder rewrites the source package to **`prime-agent`**
and the command to **`prime-agent`**, with entrypoint **`dist/bundle/cli.js`**.
Do not infer the published package identity from the source package.json.

The existing updater runs the detected global package manager against the
manifest tarball. Supported command builders include npm, pnpm, yarn, and Bun;
that source support is not a claim that each has been integration-tested.

Keep the package name and `dist/bundle/cli.js` and
`dist/bundle/cli-node.js` paths stable. The bridge also retains a thin
`dist/cli.js` alias; that compatibility alias does not expand the tested version
scope. In published v0.9.5–v0.9.8 npm
artifacts, the packer moves the TS bundle to `cli-node.js` and puts the old
native-migration shim at `cli.js`. When that shim falls back to Node, the
updater's original entrypoint is `cli-node.js`. After package replacement the
old CLI and TUI execute their original Node executable with that original
absolute JavaScript entrypoint path. Both paths must run the new Rust bridge;
a new command shim elsewhere does not repair this relaunch. The bridge must forward arguments, signals, terminal
I/O, and exit codes and remain usable when package-manager install scripts are
disabled. It must not remove its own package while the old process still needs
to relaunch through it.

### Failed migration and retry

The bridge includes the checksum-pinned, genuine v0.9.8 TypeScript package as
recovery. A host that cannot execute Rust must retain a usable public command,
daemon, worker, and saved sessions. Explicit updates report failure; ordinary
launches use recovery without repeatedly attempting the same failed install.

For bridge-driven channel installs, the native executable must pass the bounded
staged version probe before the installer replaces the public launcher. A valid
archive checksum alone does not establish that the host can execute its payload.

An explicit retry after failure must consult the current release through the
preserved updater, including downloading its updated bridge and installer.
Retrying only the failed bridge's pinned version would prevent a later release
from adding support for that host. The retry may report success only after a
working native version and its corresponding migration receipt are verified.

## Managed native requirements

The v0.9.5–v0.9.8 updater executes the installer bundled in the **old** release.
Replacing only the new archive's install.sh cannot affect that installation.
The old installer downloads
`releases/vVERSION/prime-agent-VERSION-PLATFORM.tar.gz`, checks its checksum,
and requires these regular files at the archive root:

- `prime-agent`
- `package.json` with the target version
- `install.sh`
- `prime-agent-runtime/pyproject.toml`
- `prime-agent-runtime/src/rlm/repl.py`
- `theme/prime.json`
- `export-html/template.html`
- `photon_rs_bg.wasm`

It requires `prime-agent --version` to print the bare target version and
`prime-agent --help` to succeed. It then installs to
`releases/VERSION-PLATFORM-SHA256[.SUFFIX]/`, writes `.archive-sha256` and
`.install-source`, and atomically changes `bin/prime-agent`. The managed-root
marker is `prime-agent-native-v1`.

These same legacy files are revalidated by the still-running TS client before
it can find the new launcher for restart. They must remain present after
activation, including the two metadata files written by the old installer.
The next Rust update must recognize this managed installation layout.

The manifest parser prefers `binariesV2` over `binaries`; each accepted entry
must have an exact platform-specific filename and lowercase 64-digit SHA-256.
Retain the legacy platforms in the manifest only when the corresponding
artifacts can actually run on those hosts.

## Daemon and TUI handoff

All audited versions launch the newly installed entrypoint with:

```text
update --internal-update-restart-coordinator --daemon-socket SOCKET
       --internal-update-restart-status STATUS_PATH
       [--internal-update-restart-origin SESSION_ID]
```

The TS parent creates the status directory but **does not create a staged
status file**. The coordinator must initialize it. TS polls a version-1 JSON
record with `requestId`, `socketPath`, `phase`, `coordinator.pid`,
`counts: {total, restored, resumed, failed}`, `startedAt`, and `updatedAt`.
Terminal phases are `complete`, `skipped`, and `failed`; other phases include
`starting`, `preparing`, `stopping`, `starting_daemon`, and `restoring`.
`heartbeatAt`, predecessor/successor identities, failures, and message are
optional. Keep progress live during a long restore.

This differs from the newer Rust staged-update FSM and its status schema.
Recognizing the flag alone is insufficient: a legacy adapter must initialize
and maintain TS-compatible status and use the TS daemon's
`prepare_update_restart` / shutdown / session restoration contract. The parent
otherwise reports a restart warning even if installation succeeded.

For `/update`, the old TUI runs the update subprocess with
`PRIME_AGENT_INTERACTIVE_SELF_UPDATE=1`, disposes its old connection, launches
the coordinator itself, and relaunches with its saved session file. Do not
restart the daemon prematurely from the installer or an executable probe.

The TS daemon persists its restart manifest before replying to preparation.
A lost reply therefore does not prove that preparation failed. Record a durable
binding to the predecessor, socket, target release, and attempt before sending
the request; recover a fresh scoped TS manifest only through that binding.
Retain pending source manifests through ordinary startup cleanup until their
state has been adopted. A definitive preparation refusal with no new manifest
must allow another attempt. Queued actions must remain paused while the resumed
continuation is admitted, so follow-up input cannot run ahead of that turn.

## Platform limits and release claims

The old native distribution supports Darwin arm64/x64 and Linux arm64/x64,
including `linux-arm64-musl`, `linux-x64-baseline`, `linux-x64-musl`, and
`linux-x64-musl-baseline`. The Rust release matrix currently ships GNU Linux
builds with a GLIBC 2.35 ceiling and no musl target. A GNU archive must never be
renamed to a musl suffix: that would turn a controlled refusal into a broken
installation. Supporting Alpine/musl requires real musl artifacts and runtime
verification. Older glibc hosts likewise need a compatible build or a clear
unsupported-platform result before activation.

The TS `baseline` suffix selects x64 CPUs without AVX2. Rust can reuse its
ordinary x64 artifact for that alias only after verifying its target CPU and
all bundled native dependencies work without AVX2; the absence of a separate
Rust baseline target is not by itself proof.

“All versions since 0.6” describes the source-version range, not an exemption
from platform support. Do not claim every prior platform migrates until those
platform gates pass. Test all 18 published npm releases, all four native source
releases, CLI and TUI entrypoints, session preservation, daemon handoff, and a
second Rust update using assembled artifacts.
