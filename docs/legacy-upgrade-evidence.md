# Legacy update compatibility evidence

This is unreleased-candidate evidence, not approval to publish v1. All builds
and runtime tests after the remote-only instruction ran in Prime sandboxes.
Support scope starts at 0.6.0; no earlier versions are required.

## Current verification status

The recovery-hardening snapshot passed the full repository gate, but its real
TS `/update` rerun exposed a request-ID collision after reconnecting: TS replayed
the preparation response instead of executing shutdown. The follow-up uses
distinct preparation and shutdown envelope IDs. A deliberate collision fails
the regression; the fix passes all six coordinator tests. Full gates and actual
migrations for this follow-up remain pending. Earlier results below are not
attributed to the latest source.

The consolidated full run encountered `ETXTBSY` (text file busy) in the existing
`update::download::tests::stages_a_local_payload_directory` test. A diagnostic
single-test run and the complete core library suite then passed (1,160 passed,
3 ignored), without product changes or retry logic. The cause is unproven; the
original failure is retained in `make-check-hardened-etxtbsy-red.log`. One fresh
full run passed; this does not by itself establish that the failure is fixed.

| Check | Verified result |
| --- | --- |
| npm CLI and TUI migration, all 18 stable TS versions | 36/36 on optimized candidate before final recovery hardening |
| Native CLI and TUI migration, TS 0.9.5–0.9.8 | 8/8 on that optimized candidate |
| Subsequent Rust 1.0.0 → 1.0.1 update | Passed through the original custom public command |
| Fresh curl installation and reinstallation | Passed with final staged-probe installer |
| Unusable native executable | Red reproduced; fixed installer retained usable TS recovery |
| Failed migration followed by a newer release | Original update command reached Rust 1.0.1 |
| Lost prepare response and retained queued work | Six focused coordinator tests passed; red-first regression reproduced |
| Startup cleanup preserves pending recovery manifests | Two focused tests passed |
| Busy-session continuation before follow-up input | Real worker regression reproduced red; 19 focused restore tests passed |
| npm bridge unit suite | 25 passed, including IPC, fd3, signals, retry, and prefix behavior |
| Packaging suites | 39 passed: native compatibility, restamping, decoder, catalog |
| Consolidated full repository gate | fmt, clippy, 5,206 tests passed (19 ignored), release build passed |

## Published-version matrix

The npm runs use unchanged, checksum-verified published packages and their real
public CLI/TUI entrypoints. Every version below passed both commands.

| Versions | CLI cases | TUI cases |
| --- | ---: | ---: |
| 0.6.0, 0.6.1 | 2 | 2 |
| 0.7.0–0.7.4 | 5 | 5 |
| 0.8.0, 0.8.1 | 2 | 2 |
| 0.9.0–0.9.8 | 9 | 9 |

Native installs additionally cover every stable native TS release,
0.9.5–0.9.8, using each archive's unchanged old installer.
The TUI runs require completed restoration, the original saved session attached
to a Rust worker, a preserved transcript prefix, responsive input, and no
restart warnings. CLI checks include version/help, checksum refusal, state
preservation, and paths with spaces.

The optimized Linux x64 snapshot tested before final recovery hardening:

- Rust 1.0.0 archive: `7a5e663b535d1755504f8315d4f13de0857ed746ac5c6fdc6c5e55db84ec11b3`.
- Rust 1.0.1 archive: `f46a36e1456dc6d7ddfefaf85bad68b29a0b06d863cb1577ce5e3445d4cad97a`.
- Shipped executable: `0dbfb29af17614870f613017de2c6a11b25aa80572390a61dbe4d42c36335227`.

Independent source archive digests and the exact version inventory live in
[legacy-release-inventory.json](legacy-release-inventory.json).
[The compatibility contract](legacy-upgrade-contract.md) describes the layouts,
wire fields, and required recovery behavior.

## Failure and usability evidence

**Unusable executable:** the actual TS 0.6.0 updater installed a checksum-valid
archive whose native executable named a nonexistent interpreter. With the
old probe condition, the npm launcher was replaced and the command exited 127.
With the fix, the staged probe refused activation, retained the npm symlink,
wrote no success receipt, and left a genuine TS 0.9.8 daemon/worker able to
resume the original session and accept input. The npm/native prefixes overlapped.

**Future retry:** after an unsupported architecture caused migration to fail,
the feed advanced from 1.0.0 to 1.0.1 and host support was restored. The original
public update command fetched the new bridge and installer, activated Rust
1.0.1, and resumed the saved session. An explicit retry that remains unsupported
must still fail, despite the old TS updater's warning-only success exit.

**Lost response:** a Unix-socket protocol fixture writes a TS-shaped manifest
containing queued work, then drops the prepare reply. The Rust coordinator
recovers it through its durable predecessor/socket/attempt binding before
shutdown. Disabling recovery makes the regression fail. Tests reject foreign
owners and stale data and permit retry after a definitive preparation refusal.
Startup cleanup preserves pending source manifests until adoption.

**Busy queue:** a real scheduled Rust worker with a scripted engine proves that
restored follow-up input stays parked until continuation admission. Disabling
the input pause consumes the queue too early; restoring it passes.

**Usability:** separate real TS 0.6.0 npm and TS 0.9.8 native handoffs execute
and persist a controlled Bash command after restoration, preserving prior
transcript bytes. No provider inference or IPython execution was tested.

The genuine fallback is the complete published TS 0.9.8 package, pinned to
SHA-256 `d7b72785119efc28bfbca8ec4a7f47a1fcdcf47fcd8cebdb60bffaa79e3e1274`.
The final staged-probe installer tested here is
`323328cea0ede4d60aedfef486ba383ea081457e65ccedb1782ca6a0575a7f09`.

## Reproduction and retained reports

Run these only in an isolated test host, with temporary homes and no real
credentials. Harnesses accept candidate archives and report paths; use their
`--help` for the published source archive/checksum/prefix arguments.

| Harness | Purpose |
| --- | --- |
| `scripts/release/verify_legacy_release.py` | Download and verify a genuine native TS release, then exercise its updater |
| `scripts/release/test_legacy_upgrade.py` | Native CLI, checksum refusal, custom paths, second Rust update |
| `scripts/release/test_legacy_npm_upgrade.py` | Genuine npm CLI migration |
| `scripts/release/test_legacy_tui_upgrade.py` | Actual npm/native TUI update with saved-session restoration |
| `scripts/release/test_legacy_npm_fallback.py` | Unsupported host, unusable payload, and later-release recovery |
| `scripts/release/test_legacy_runtime_restart.py` | Real post-migration worker command execution |
| `scripts/release/test_channel_install.py` | Current curl installer, reinstall, and user-file preservation |

Reports, hashes, TUI captures, and logs were downloaded without agent binaries
to `/tmp/prime-legacy-artifacts/` in the maintainer workspace. Key reports:
`native-upgrade-evidence-optimized.tar.gz`, `native-tui-optimized-0.9.{5,6,7,8}.json`,
`channel-install-probe-final.json`, `probe-red.json`, `probe-green.json`,
`future-release-recovery.json`, `legacy-recovery-red-green.tar.gz`, and
`make-check-hardened.log`. Matrix bundles contain each case's exact archive and
bridge hashes. Intermediate evidence remains in Git history and
`evidence-history-before-condensing.md` beside the raw reports.

## Remaining release gates and limits

- Complete full gates and the migration matrix against the corrected optimized artifact.
- Verify production artifacts on all supported hosts. The Linux candidate was
  built on Debian 12 with fixture catalog data. Its highest required GLIBC
  symbol is 2.34, but that is not an Ubuntu 22.04 runtime test.
- Stable release CI builds and livechecks Linux x64/arm64 in pinned Ubuntu 22.04,
  and gates fresh installation plus TS migration on Linux and macOS arm64.
  macOS x64 currently has a Rosetta version probe, not a full migration gate.
- Older macOS arm64 CLI runs, two Rust beta CLI runs, and retained TS prerelease
  runs passed earlier snapshots; they do not establish final platform coverage
  or coverage of every historical beta.
- GNU binaries do not establish musl, older-glibc, or unsupported-CPU support.
  A working TS fallback is not a successful Rust migration.
- npm was integration-tested; pnpm, Yarn, and Bun were not. Beta artifact reuse
  does not execute the new fresh-install gate.
- No final live-catalog, public stable endpoint, release-tag, or publication
  verification is claimed. Full rendered-frame and exhaustive wire-byte parity
  were not measured; the unchanged TS clients exercise the actual handoff.
