# Legacy update compatibility evidence

These are unreleased-candidate results, not approval to promote a stable release.
Rerun on the final release artifacts and each supported platform before promotion.

## Optimized Linux native CLI verification

After the full remote `make check` passed and the workspace release-profile
build completed, the final current-source optimized executable was split and
assembled through the normal release scripts. Both 1.0.0 and 1.0.1 archives
passed `verify_release.py`, including payload, checksum, manifest, bundled
catalog, and executable live checks. These immutable candidates include the
latest restored-session busy-state fix as well as the coordinator fixes.

All four published native TS stable versions, v0.9.5 through v0.9.8, passed
the real CLI upgrade again against this optimized artifact. The v0.9.8 case
also passed the subsequent Rust 1.0.0 → 1.0.1 update through its original
custom public command. The native cases ran sequentially alongside two npm
workers, keeping the agreed maximum of three simultaneous migration tests.
The same checksum-refusal, retained-release, user-state byte preservation,
paths-with-spaces, version/help, and successor-cleanup assertions passed.

Optimized tested artifact SHA-256 hashes:

- Rust 1.0.0 archive: `7a5e663b535d1755504f8315d4f13de0857ed746ac5c6fdc6c5e55db84ec11b3`.
- Rust 1.0.1 archive: `f46a36e1456dc6d7ddfefaf85bad68b29a0b06d863cb1577ce5e3445d4cad97a`.
- Shared shipped executable: `0dbfb29af17614870f613017de2c6a11b25aa80572390a61dbe4d42c36335227`.
- Split-debug decoder: `2c7953793f845ba61edcba8830bd469bab3df1d1e9be63e3f2f0051c6f2fcefa`.

The source TS archives are the same checksum-verified archives listed in the
Linux table below. Definitive native reports are under
`/tmp/native-legacy-tests/optimized/` in the Prime sandbox. The report-only
bundle `/tmp/prime-legacy-artifacts/native-upgrade-evidence-optimized.tar.gz`
(SHA-256 `a890d858289758824b2a3d34c6f91b5d2e709fe9d1aa00bcafaf314aa70dc542`)
contains those reports, exact source hashes in
`native-optimized-source-sha256.json`, both release manifests, assembly and
verification logs, and prior regression evidence. No agent binaries were
downloaded or run locally for this verification.

This is an optimized Linux x64 test on Debian Bookworm with fixture catalog
data. It still does not establish the production GLIBC 2.35 baseline,
other platform builds, final live catalogs, or publication through public
stable endpoints. Earlier macOS and development-build evidence below is
preserved as historical evidence, not substituted for these optimized results.

## Initial macOS native CLI migrations

On October 9, 2026, the macOS arm64 binaries published in Prime Agent v0.9.5,
v0.9.6, v0.9.7, and v0.9.8 each successfully ran `prime-agent update` into a
Rust candidate packaged as 1.0.0. These are the native TypeScript stable
releases; earlier versions used npm and need separate npm-path evidence.

The test installed each original archive with the unchanged `install.sh`
extracted from that archive. It then ran the released executable's real update
command against a loopback manifest and candidate archive. No update-command,
installer, executable, or checksum-verification mocks were used. Rust was built
in the development profile; bundled catalog data came from the fixture generator.

Each case also verified:

- A deliberately incorrect candidate checksum fails without changing the active
  TypeScript symlink or executable bytes.
- The successful upgrade retains the prior release for recovery.
- The public command resolves to the activated Rust executable and passes its
  version and help probes.
- Existing settings, authentication, session, and skill witness files retain
  their exact bytes. These witnesses do not prove semantic session resume.
- Installation works with spaces in the install and public-command directories.

The regression was reproduced with the same Rust payload minus `install.sh`:
the actual v0.9.8 update command exited 1 with
`error: missing archive asset: install.sh`. The complete compatibility payload
passed. This isolates the original native packaging failure.

All installation directories, HOME, temporary directories, daemon paths, and
user-state paths were isolated. The harness records archive and installer
SHA-256 hashes plus command output in JSON. The source archives were verified
against their published checksum inventories before testing.

| Published TS version | macOS arm64 archive SHA-256 |
| --- | --- |
| 0.9.5 | `fc74d38ac4450a495678333e63a88b2a726c3ad5a30c2e45b122c8095729e5f6` |
| 0.9.6 | `97aff54310fde0c7a1d2a596a362db526f553395348a81696ec12c7c339052e1` |
| 0.9.7 | `c28db14d0cfd53375d1a5007d8edad521199ba289e7b6332e9886604a0a3c22b` |
| 0.9.8 | `078c9abd519978ef27f6404367e37a2981267db47f1b95b60940ea7fe6ead8b9` |

The initial green candidate archive SHA-256 was
`ca790c71a77e40369d849258d969132cf27822ff34693adfdab755946c0e6019`;
its Rust executable SHA-256 was
`03b8036847be6259546e1f6f403e99915ea6f7bb69fcb2623846cbb89d080768`.
Subsequent source changes require reassembly and rerunning the tests.

## Initial macOS second Rust update

The standard layout also passed the full sequence from released TS v0.9.8 to
Rust candidate 1.0.0 and then candidate 1.0.1. The second update ran through the
same original public command, downloaded the next archive from a loopback
stable channel, moved the old TS installation tree into the retained legacy
location, and replaced the public launcher. That original command reported
1.0.1 afterward. User-state witness bytes remained unchanged. The real installer
also reported successful kernel preparation; this is not a session/tool test.

The 1.0.1 candidate archive SHA-256 was
`8371e748f4162a1563ee6e881a1a8b8e00df14cc8cf750186a3eaa2b6448a0c1`;
its executable SHA-256 was
`27f5f305d6a4d8666010f62b65c62a1dfcc99fe1f57d77a96bb3ec0a07cbadb4`.
This second artifact came from a later development build than the first
candidate, while the branch was still under active development.

### Regression evidence: custom installation path on the second update

The initial macOS second-update test failed when the old TS install used a
custom installation directory and a separate public-command directory. The
Rust update reported success after installing 1.0.1 into its default prefix,
but the original custom public command still reported 1.0.0. The first
TS-to-Rust update passed. The managed-install update route fixes that path;
the final Linux custom-path sequence below passed. This initial macOS case
has not been rerun against the final source snapshot.

## Intermediate Linux development snapshot

An intermediate source snapshot was compiled and tested remotely in Prime sandbox
`f2vijvm1z7zed83fjj1s1odv`, on Debian Bookworm x64. The normal split-debug and
release assembler gates passed, using a development build with line-table
debug information and fixture catalog data. This proves packaging and decoder
compatibility for these test artifacts; it does **not** prove the production
GLIBC 2.35 baseline or substitute for release-profile platform builds.

All four actual published native TS stable binaries passed `prime-agent update`
into the final Rust 1.0.0 candidate. The v0.9.8 case additionally updated from
that Rust installation to the 1.0.1 candidate through the same original custom
public command. Both custom directories contained spaces. The second update
completed, the original command reported 1.0.1, state witness bytes survived,
and the harness shut down the isolated successor daemon before cleanup.
Each first-upgrade case also retained the previous release and passed the
corrupt-checksum refusal and version/help checks described above.

| Published TS version | Linux x64 archive SHA-256 | Result |
| --- | --- | --- |
| 0.9.5 | `bc4b0ed791d1e8b3b5d6a95249a60306d9579fc0d6038e5d7d82f068d81f008d` | Passed |
| 0.9.6 | `2ea7812a310bc16ae0c99fff7bca1d1e465077af38cf103aad167f10c2129801` | Passed |
| 0.9.7 | `47981c19396bcaabfabc4d6d788e64d55c057288d8676fc5733ab525803be066` | Passed |
| 0.9.8 | `83fb09129bf78e3e60268212cd70932166591b15188caa70c1b0efbcc76235e2` | Passed, including second Rust update |

Intermediate development-candidate hashes:

- Rust 1.0.0 archive: `1e4acab3f158d0450314e30fe0402526eaf8150655011f42ee5ad0636cb14828`.
- Rust 1.0.1 archive: `19ea6c0f8995905e778c14904583f127d6c04aac58fd25d72fad42d7fed71b48`.
- Shared shipped executable: `671a3ccebf7e0f8fe9c52f76a77cff486b822bdb3a090fb3c4dcb437959d57dc`.

The version differs through the packaged manifest, matching the product's
packaged-version contract. Reports, source hashes, manifests, and build logs
were downloaded without binaries into
`/tmp/prime-legacy-artifacts/native-upgrade-evidence-final.tar.gz` (SHA-256
`f6a62996fbdb9500daafce87ac3f7fdd6b75b1d847738b769a204773c348562f`).
The archive contains `native-source-sha256.json` and the four final reports,
plus the earlier native regression failures.

### Additional regressions exposed by the real second update

The versioned-only local feed first caught a wrong native download URL: the
new managed route requested the archive from the feed root instead of
`releases/vVERSION/`. After correcting the URL, the actual coordinator exited
101 with `illegal coordinator transition Acquire -> Preparing`: adoption had
reset its staged status. A daemonless transition also skipped `Stopping`.
The fixes preserve the staged record, follow the valid stop sequence, and
observe/reap an exited coordinator rather than waiting on a zombie process.
The final custom-path second-update case passed after these fixes. The actual
panic stderr and 404 report are retained in the evidence archive.

## Reproduce

Download an original native archive and its published checksum inventory,
verify the archive, and extract its `install.sh` without editing it. Assemble
the candidate with `scripts/release/assemble_artifacts.py`. Then run:

```sh
python3 scripts/release/test_legacy_upgrade.py \
  --archive /tmp/prime-agent-1.0.0-darwin-arm64.tar.gz \
  --previous-archive /tmp/prime-agent-0.9.8-darwin-arm64.tar.gz \
  --installer-file /tmp/install-0.9.8.sh \
  --entrypoint cli \
  --report /tmp/native-upgrade-report.json
```

Repeat for each native release. `--installer-ref` also accepts a verified
release commit containing the installer, but prefer the exact published bytes.
Do not infer older Prime releases from tag names alone: this repository also
contains inherited upstream tags.

To test a second Rust update, add `--next-archive` pointing at a newer real
Rust archive and select `--layout standard` for the normal installation layout.
The harness advances the local stable manifest and pointer, serves the next
archive's installer, runs the migrated command's update, and checks the version
through that same public command.

## Remaining gates

The native CLI results alone do not establish npm migration, TUI `/update`,
live-daemon handoff, resumed-session execution, kernel tool operation, rollback
execution, or untested platforms such as Linux arm64 and Intel macOS. Check the separate reports for
those gates; do not treat missing evidence as a pass. Windows did not have a
native TS artifact in these releases and needs its applicable installation path
tested separately.

## Optimized npm CLI and TUI matrix before final recovery hardening

All 18 stable npm versions v0.6.0–v0.9.8 were rerun through both the unchanged
CLI updater and real TUI `/update` against the optimized Linux release
candidate: **36/36 passed**, including saved-session attachment, transcript
preservation, Rust version, responsive input, and no restart warnings.

- Rust archive SHA256: `7a5e663b535d1755504f8315d4f13de0857ed746ac5c6fdc6c5e55db84ec11b3`.
- npm bridge SHA256: `3b73097ead8dff7a14cd1ecf3ba80dca682155da413f95ee5bdc9abc578a249b`.
- Downloaded complete reports: `/tmp/prime-legacy-artifacts/npm-optimized-stable-matrix.tar.gz`.

This run predates the subsequent staged-executable installer probe, future
release retry recovery, and lost-prepare-response hardening. Those changes
need their own evidence and the consolidated final artifact rerun; this
snapshot is retained rather than mislabeled as that final result.

## Full stable npm CLI and TUI matrix

All **18 published stable versions from v0.6.0 through v0.9.8 passed both
`prime-agent update` and the real interactive `/update`** in the remote Linux
sandbox: 36 successful integration cases, no failures. Every case starts from
its checksum-verified published npm artifact and invokes its unchanged public
entrypoint. These are actual per-version runs, not source-equivalence claims.

The CLI checks require Rust activation during the old updater's own coordinator
invocation, matching version/help, and preserved user skills. Each TUI check
resumes a real saved session before issuing `/update`, then requires the Rust
daemon's completed restoration status, original session attachment, unchanged
transcript prefix, expected public version, responsive local input, and no
coordinator/restart failure warnings. No provider inference was sent.

| Published npm version | `prime-agent update` | TUI `/update` |
| --- | --- | --- |
| 0.6.0 | Passed | Passed |
| 0.6.1 | Passed | Passed |
| 0.7.0 | Passed | Passed |
| 0.7.1 | Passed | Passed |
| 0.7.2 | Passed | Passed |
| 0.7.3 | Passed | Passed |
| 0.7.4 | Passed | Passed |
| 0.8.0 | Passed | Passed |
| 0.8.1 | Passed | Passed |
| 0.9.0 | Passed | Passed |
| 0.9.1 | Passed | Passed |
| 0.9.2 | Passed | Passed |
| 0.9.3 | Passed | Passed |
| 0.9.4 | Passed | Passed |
| 0.9.5 | Passed | Passed |
| 0.9.6 | Passed | Passed |
| 0.9.7 | Passed | Passed |
| 0.9.8 | Passed | Passed |

Every one of these 36 cases used the same artifacts:

- Rust development candidate SHA256: `1e4acab3f158d0450314e30fe0402526eaf8150655011f42ee5ad0636cb14828` (`candidate-fixed2`).
- Dependency-bearing, genuine-TS-fallback npm bridge SHA256: `3b73097ead8dff7a14cd1ecf3ba80dca682155da413f95ee5bdc9abc578a249b`.

This snapshot includes the legacy coordinator fixes and final npm fallback
hardening. It predates the later optimized release build and busy-session pause
fix; it is not evidence that the final release archive was tested. Native
installer variants and additional platform coverage are documented separately.

Exact per-case reports, rendered TUI captures, original artifact checksums,
coordinator/version results, and npm logs are preserved in
`/tmp/prime-legacy-artifacts/npm-final-stable-matrix.tar.gz` (remote source:
`/tmp/npm-legacy-tests/final-matrix/`). The earlier CLI matrix below retains
its distinct source/candidate history; this new stable matrix supersedes its
stable-version npm coverage.

## Earlier npm CLI migration snapshots

**20 actual published TypeScript npm artifacts in the requested v0.6.0+
scope passed on Linux x64 in the Prime sandbox:** all 18 stable releases,
the retained rolling TypeScript beta, and the fhcache candidate. The exact
versions are listed below. This does not claim coverage of overwritten
rolling beta artifacts that are no longer retained.

The unchanged old CLI ran `update --force` against a loopback release manifest.
Its normal restart-coordinator launch invoked the replacement npm bridge and
installed Rust during the update, without a manual installer or bridge call.
The test rejected a missing Rust installation or any restart warning before
trying another command. The original npm entrypoint then reported 1.0.0 and
passed its help probe. All cases preserved an existing skill witness
byte-for-byte and used prefixes containing spaces. No daemon was running for
these cases.

Each source tarball was verified against published SHA256SUMS, except the
fhcache candidate, which has no published checksum inventory and was pinned
against GitHub's independent API `asset.digest`. The rolling beta was checked
against both sources. Real historical dependencies were installed into
temporary prefixes with npm lifecycle scripts disabled. The harness checked
the old entrypoint bytes against the released tarball. HOME, npm prefix/cache,
daemon socket, and Rust prefix were isolated, with at most three migrations
running concurrently. All expanded testing ran remotely after local testing
was stopped.

| Published npm version | Source tarball SHA-256 | Result |
| --- | --- | --- |
| 0.6.0 | `8ef229a0422398174ba8f0ba4f7101adfc614b023a8f819f6ef3920e5d2350c6` | Passed |
| 0.6.1 | `4c7150dbfe5807c8480676d20c3104e63045b8ca2463abf38f021062e9fcacef` | Passed |
| 0.7.0 | `88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b` | Passed |
| 0.7.1 | `d68612c83239caafab72cc76c55ac572bfd07a059ea8fbd2a3ddbe1f2b55dcdb` | Passed |
| 0.7.2 | `bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e` | Passed |
| 0.7.3 | `2a188738318b91ff91ea77b8a0b215c41543cf0483fcb18a53475dc4e7032784` | Passed |
| 0.7.4 | `dea045d7c170466a102e030e940f459cc13f2c113465f40be1c7505d80405d2e` | Passed |
| 0.8.0 | `f5b0093c7e0fddb73f94773d74383585456adfa84f12a4082d3098f23bb8fab6` | Passed |
| 0.8.1 | `46c24db1782dd31adc35d5c6cbcc75564faba6ced3bf2ccf03d836ee77134475` | Passed |
| 0.9.0 | `fc560ec74195297999405d4fbfd0d308598cf502e0fccef7f02eb60032213108` | Passed |
| 0.9.1 | `573bce0cd004fc62052e9a924089941b7f39266ab71e66a94c85a1f9d35835ba` | Passed |
| 0.9.1-fhcache1 | `4a461bf7fc9d8e6e4e61471b66341aff05ba94e02c6c25f678851d26d1b27d2c` | Passed |
| 0.9.2 | `d649b9f0258c77de7d02aba33d786925ce41a36b601e8e24eef0f00bdc2f1f49` | Passed |
| 0.9.3 | `ce71049389877770aa31b9be64c473685a86159adbbd2466bd43e4a9113242f1` | Passed |
| 0.9.4 | `b8d752a53d11a8c9a7580e1fb5fc24f7ce74ccad979c7e6e6aa8880fc3ad90b0` | Passed |
| 0.9.5 | `349f1682c7909550842f1b04a71ba95814341b136474ade736df93f8ec006876` | Passed |
| 0.9.6 | `e5bf0e349e55b3f75c79e66006c993b10c51ed1c9bf15863b06658fcaf0232b2` | Passed |
| 0.9.7 | `d696f2636cd7780d2d67296142bc1d13d72960c8be4e5cfae0bbba82f9d8707d` | Passed |
| 0.9.8 | `d7b72785119efc28bfbca8ec4a7f47a1fcdcf47fcd8cebdb60bffaa79e3e1274` | Passed |
| 0.9.8-beta.2286.1.7d442aa | `7a311e2d7fd45c0b9f134197bb3101ebc11233c6c2bf649c4d574a0d98d3473b` | Passed |

These runs used two development-candidate snapshots, **not one final release
snapshot**. The 18 stable cases ran before the later daemon identity fix;
the beta and candidate cases ran afterward. Revalidate the final release
artifacts before promotion.

| Cases | Rust archive SHA-256 | npm bridge SHA-256 |
| --- | --- | --- |
| Stable v0.6.0–v0.9.8 (18 cases) | `c4f9771388bf27b493081cd74e09c8d532091be0ddbb5b7f1b47d98c3dcf55bb` | `7dc475f970344f9573523c0f2169914fbde9a4ac5a2e906ad68e98a88cf6c955` |
| fhcache candidate | `8472bbeeb7944069694ce5be9b7d422898c2dc71489d9f0676c5e1639e318fdf` | `e6c8cb136c44ac9fc13d397724bce088a2565625ee4ac5e5d90edda9e3ce985b` |
| Rolling TS beta | `8472bbeeb7944069694ce5be9b7d422898c2dc71489d9f0676c5e1639e318fdf` | `19be530452bdaf0b2975c5f582c222a4ce34e6c291002590cb96dd64904bcf98` |

The bridge unit suite also passed 17 tests remotely. The rolling beta case
read `beta.json`; stable/fhcache cases read `latest.json`.

### Regression reproduced and fixed: missing npm fallback entrypoint

The first macOS v0.9.8 attempt replaced the package but could not launch its
coordinator. Published v0.9.5–v0.9.8 npm packages put a native-migration shim
at `dist/bundle/cli.js` and the TS application at `dist/bundle/cli-node.js`.
The old updater relaunches `cli-node.js`, which the initial bridge omitted.
Shipping both paths fixed the cause; all four affected Linux stable versions
passed afterward. macOS v0.9.8 has not been rerun after that fix.

Reports, checksums, and extra-artifact provenance are preserved remotely under
`/tmp/npm-legacy-tests/` and in the downloaded archive
`/tmp/prime-legacy-artifacts/npm-matrix-evidence-complete.tar.gz`.

Reproduce in an isolated environment:

```sh
python3 scripts/release/test_legacy_npm_upgrade.py \
  --previous-archive /tmp/prime-agent-0.6.0.tgz \
  --previous-checksums /tmp/TS-0.6.0-SHA256SUMS \
  --fallback-tarball /tmp/prime-agent-0.9.8.tgz \
  --archive /tmp/prime-agent-1.0.0-linux-x64.tar.gz \
  --report /tmp/npm-upgrade-report.json
```

An optional `--previous-prefix` copies a prepared installation with real
dependencies into the test's isolated prefix. Without it, preparing the
historical installation requires network access. These npm cases do not
establish TUI `/update`, running-daemon handoff, resumed-session execution,
kernel tool operation, a subsequent Rust update, or other platform coverage;
see separate sections.

## Published Rust beta CLI upgrade evidence (Linux x64)

The real published `0.9.9-beta.4` and `0.9.9-beta.60` binaries both completed
`prime-agent update` to the assembled 1.0.0 candidate inside Prime sandbox
`f2vijvm1z7zed83fjj1s1odv`. Each public launcher subsequently reported `1.0.0`,
the install marker retained `channel beta`, and an existing state witness
retained its exact bytes. The old archives were verified against the
`SHA256SUMS` files attached to their respective GitHub releases.

| Published Rust version | Source Linux x64 archive SHA-256 | Result |
| --- | --- | --- |
| 0.9.9-beta.4 | `e743b45d95782728624f81bf5545d094e4ba9ddaa7941518cda11431896c680a` | Passed |
| 0.9.9-beta.60 | `bfee8ba171df5b3344a5ad646eec4cceda52f52658265e9a6ff9605b92176c3a` | Passed |

The tested 1.0.0 candidate archive SHA-256 was
`8472bbeeb7944069694ce5be9b7d422898c2dc71489d9f0676c5e1639e318fdf`.
The completed report is preserved locally at
`/tmp/prime-legacy-artifacts/rust-beta-upgrade-report.json` and remotely at
`/tmp/rust-beta-upgrade-final2/report.json`.

These cases manually staged the checksum-verified old payloads in the Rust
installer layout with a beta install marker and public command symlink.
They did not run the historical installer to create that layout. Each case
used an isolated HOME and explicit custom `PRIME_AGENT_RUST_PREFIX`, a
loopback installer URL override, and a local beta release feed. The explicit
`PRIME_AGENT_ALLOW_HTTP=1` test option enabled that loopback feed; the initial
attempt without it correctly refused the plaintext download base. The tests
exercised the unchanged old binaries' actual update commands and the current
installer, rather than replacing the updater logic. They do not establish
live-daemon handoff, TUI behavior, automatic custom-prefix discovery in old
binaries, explicit channel switching, or coverage of every intermediate Rust
beta. A production beta upgrade also requires publishing the candidate to the
beta feed; changing only `latest.json` does not change beta channel selection.

## Live daemon and persisted-session handoff

On 2026-10-09, isolated Linux x64 runs in Prime sandbox
`f2vijvm1z7zed83fjj1s1odv` migrated real shipped TypeScript daemons at both
endpoints: npm 0.6.0 and native 0.9.8. Both used the final, normally assembled
`prime-agent-1.0.0-linux-x64.tar.gz` candidate with SHA-256
`8472bbeeb7944069694ce5be9b7d422898c2dc71489d9f0676c5e1639e318fdf`.

The harness seeded a valid persisted transcript containing an assistant fixture,
opened it through the actual TypeScript daemon and worker, and appended a
custom-message checkpoint through its wire protocol. It then invoked the Rust
legacy coordinator against that live daemon. No provider inference was performed.
Both runs reached coordinator phase `complete`, with one session restored, zero
resumed, and zero failures. The successor had a distinct process ID, the expected
schema, and `appVersion: 1.0.0`; its session listing contained the original durable
session ID and file in ready state. The original transcript remained an unchanged
byte prefix of the resulting file.

A preceding run against the earlier candidate failed at the strict successor
identity check: the packaged CLI reported 1.0.0 while the daemon advertised its
compiled 0.9.8 version. The fix initializes the supervisor and worker product
version from the composition root's packaged version. The identity check was
retained; the same two fixture runs then passed against the final candidate.
Both failed and successful reports are retained.

Reproduce the native endpoint with Python 3.12 or newer:

```sh
python3 scripts/release/test_legacy_runtime_restart.py \
  --legacy-archive /tmp/tui-legacy-tests/prime-agent-0.9.8-linux-x64.tar.gz \
  --candidate-archive /tmp/candidate-fixed/prime-agent-1.0.0-linux-x64.tar.gz \
  --with-session --report /tmp/live-legacy-runtime-0.9.8-fixed.json
```

For the npm endpoint, replace `--legacy-archive` with
`--legacy-npm-prefix /tmp/npm-legacy-tests/prefix-0.6.0`, an isolated installed
copy of the published package and its dependencies, and use a separate report.

The bounded report archive is preserved locally at
`/tmp/prime-legacy-artifacts/runtime-handoff-evidence.tar.gz` (7,843 bytes). It
contains both final endpoint reports, the preceding failures, an empty-roster
handoff report, and the focused coordinator test log (24 passed). That focused
suite ran before the final packaged-version fix; the live endpoint runs used
the final candidate. This proves persisted idle-session handoff at those two
endpoints. It does not establish in-flight inference, tool or subagent resumption,
or daemon migration on other operating systems.

### Final candidate: restored worker executes and persists a command

The same two endpoints (real npm 0.6.0 and native 0.9.8) were rerun against
the final `candidate-fixed2` archive, SHA-256
`1e4acab3f158d0450314e30fe0402526eaf8150655011f42ee5ad0636cb14828`.
Both passed the handoff assertions above and an additional usability check:
the restored session handled the supported `execute_bash_and_wait` command
with a controlled `printf`, returned exactly `restored-session-bash-witness`
with exit code 0, no cancellation and no truncation, and persisted the resulting
`bashExecution` message. The original durable session ID, file path, and transcript
prefix remained intact. This exercises the restored worker beyond listing or
attachment, without provider inference. It does not test IPython execution.

The current `--with-session` harness includes this assertion. Use the reproduction
command above with `/tmp/candidate-fixed2/prime-agent-1.0.0-linux-x64.tar.gz`.
Both reports and logs are preserved locally in
`/tmp/prime-legacy-artifacts/runtime-handoff-fixed2-evidence.tar.gz`.

## Actual npm v0.6.0 TUI `/update`

The actual published npm v0.6.0 TUI passed `/update` end-to-end on Linux x64
in the Prime sandbox against the later candidate-fixed2 artifact. The test
opened the unchanged old CLI in tmux, resumed a real persisted session with a
known assistant message, typed `/update `, and pressed Enter. The old TUI
naturally launched its update subprocess, coordinator, and replacement TUI;
the harness did not manufacture any coordinator calls.

The new daemon reported 1.0.0 with `updateResume.complete = true` and a new
supervisor PID. Its roster showed the original session file with an attached
client. The Rust TUI rendered the original sentinel, accepted a local input
witness, and the saved transcript retained the exact original prefix. The
original npm public command reported 1.0.0. The full terminal stream contained
no coordinator-launch failure, daemon-restart failure, or stale-daemon warning.
No inference request was sent, and the temporary TUI/daemon were cleaned up.

- Published npm source SHA-256:
  `8ef229a0422398174ba8f0ba4f7101adfc614b023a8f819f6ef3920e5d2350c6`.
- Rust archive SHA-256:
  `1e4acab3f158d0450314e30fe0402526eaf8150655011f42ee5ad0636cb14828`.
- Bridge npm archive SHA-256:
  `e6c8cb136c44ac9fc13d397724bce088a2565625ee4ac5e5d90edda9e3ce985b`.
- Report: `/tmp/prime-legacy-artifacts/npm-tui-0.6.0-final.json`.

Reproduce using a prepared isolated npm prefix with actual v0.6.0 dependencies:

```sh
python3 scripts/release/test_legacy_tui_upgrade.py \
  --previous-archive /tmp/prime-agent-0.6.0.tgz \
  --previous-checksums /tmp/TS-0.6.0-SHA256SUMS \
  --fallback-tarball /tmp/prime-agent-0.9.8.tgz \
  --previous-npm-prefix /tmp/npm-prefix-0.6.0 \
  --archive /tmp/prime-agent-1.0.0-linux-x64.tar.gz \
  --report /tmp/npm-tui-upgrade.json
```


## Busy-session queue ordering: real worker regression

On October 9, 2026, the focused restore suite passed remotely in Prime sandbox
`f2vijvm1z7zed83fjj1s1odv`: **19 tests passed, zero failed**. The regression
`legacy_busy_restore_keeps_follow_up_behind_continuation_with_a_running_worker`
uses an actually scheduled Rust worker and its real turn runner with a scripted
engine. It restores a follow-up from a busy TS session, awaits the runner's
observable idle notification before admitting continuation, and verifies that
the follow-up remains queued. After the input-pause lease releases, emitted user
messages show the interrupted-task continuation before the follow-up. It uses
no fixed sleeps or inference requests.

For red-first verification, only the input-pause acquisition was temporarily
disabled in an exclusive remote build window. The same test failed with
`restored follow-up ran before continuation admission`: the observed queue
length was zero instead of one. The exact source was then restored, verified by
SHA-256 `c88048e23c2c76790f9e724e79c50a586b775fe61b07d3bc05e9ded8a43553b4`
for `crates/pa-daemon/src/update_restore.rs`, and all 19 focused tests passed.

Reproduce the green suite with `cargo test -p pa-daemon --lib
update_restore::tests --offline`. Downloaded evidence is preserved at
`/tmp/prime-legacy-artifacts/legacy-restore-red-first.log` and
`/tmp/prime-legacy-artifacts/legacy-restore-green.log`. This proves the Rust
restore boundary's scheduling order; it does not substitute for an end-to-end
upgrade during live provider inference.

## Genuine TypeScript recovery after an unsupported-host npm upgrade

The remote Linux verifier `scripts/release/test_legacy_npm_fallback.py` ran the
unchanged published v0.6.0 npm `prime-agent update --force`, allowing npm to
replace the package with the Rust bridge. A PATH-local `uname` wrapper reported
an unavailable architecture; the actual `install-rust.sh` rejected that host.
No installer, TS application, daemon, or worker was mocked. The old updater
printed its existing package-update success message and a daemon-restart warning;
the bridge did not claim Rust activation. An explicit subsequent update exited
1 with the unsupported-host diagnostic.

The original public command remained usable: it reported genuine TypeScript
v0.9.8 with a recovery warning. A real tmux TUI resumed the original saved
session through a v0.9.8 daemon and worker, attached a client, preserved the
transcript bytes, and accepted a local input witness. No inference was sent.
The checksum-pinned fallback contains the complete published package and its
runtime assets, with npm resolving its original declared dependencies. Separate
remote packaging checks passed both normal npm installation and
`--ignore-scripts` installation.

This verifier caught an initial recovery bug: spawning another Node child
lost the TS session worker's inherited fd3. Loading the immutable fallback
module in the existing Node process preserves fd3 and IPC; the same real
session verifier passed after that fix. The bridge unit suite passed 20 tests.

Artifact identities for this run:

- Source v0.6.0 SHA256: `8ef229a0422398174ba8f0ba4f7101adfc614b023a8f819f6ef3920e5d2350c6`.
- Genuine fallback v0.9.8 SHA256: `d7b72785119efc28bfbca8ec4a7f47a1fcdcf47fcd8cebdb60bffaa79e3e1274`.
- Rust candidate SHA256: `1e4acab3f158d0450314e30fe0402526eaf8150655011f42ee5ad0636cb14828`.
- Bridge SHA256: `1e61c5d9acc79f40b82065551bd30341482d36145b9948b85d9c405f0b301735`.

Raw report: `/tmp/prime-legacy-artifacts/npm-fallback-unsupported-host.json`.
This tests architecture rejection on a supported Linux test machine; it does
not establish actual musl-host, Windows, or unsupported-CPU runtime support.

The ordinary supported-host path was rerun with the dependency-bearing fallback
package: actual npm v0.6.0 TUI `/update` passed the full persisted-session
restoration and responsive-input assertions using Rust candidate `1e4acab3...`
and bridge SHA256 `1e61c5d9acc79f40b82065551bd30341482d36145b9948b85d9c405f0b301735`.
Raw report: `/tmp/prime-legacy-artifacts/npm-tui-0.6.0-fallback-package.json`.

The actual v0.9.8 npm CLI was also rerun with that same bridge and candidate:
`prime-agent update --force` activated Rust during the old updater's natural
coordinator invocation, with version/help and user-skill preservation passing.
Raw report: `/tmp/prime-legacy-artifacts/npm-cli-0.9.8-fallback-package.json`.
Subsequent small launcher hardening for uppercase npm-prefix environment and
leading global options on explicit update was covered by the final remote
23-test unit suite, including fd3 and Node IPC preservation regressions; the
three real integration reports above retain their exact earlier bridge hash.

### Fresh channel installation and reinstall

The dedicated `scripts/release/test_channel_install.py` verifier served the current
installer and optimized Linux x64 candidate through a local HTTP channel, executed
`curl -fsSL .../install.sh | sh`, and repeated the installation. Both runs passed:
the public launcher reported 1.0.0, help worked, and settings, credentials, and a
saved-session witness remained byte-identical under an isolated home with a
prefix containing spaces. Evidence: `/tmp/prime-legacy-artifacts/channel-install-probe-final.json`.
Candidate SHA256: `7a5e663b535d1755504f8315d4f13de0857ed746ac5c6fdc6c5e55db84ec11b3`.
Installer SHA256: `323328cea0ede4d60aedfef486ba383ea081457e65ccedb1782ca6a0575a7f09`.
This identifies the tested snapshot; subsequent installer changes require a rerun.

Stable release jobs now require this verifier on Linux x64/arm64 and macOS arm64,
in addition to the real TS 0.9.8 CLI updater gate. macOS x64 is cross-built on
Apple silicon and currently has a Rosetta executable version probe, not a full
installer/migration runtime gate. Beta artifact reuse retains archive validation
but does not run the new install verifier. These remain explicit coverage limits.

Read-only symbol inspection of the optimized Linux x64 executable found a maximum
requirement of `GLIBC_2.34`, below the release ceiling of `GLIBC_2.35`. This candidate
was built on Debian 12: the inspection is not evidence of an Ubuntu 22.04 build or
runtime test. The stable release Linux jobs separately build and livecheck inside
the pinned Ubuntu 22.04 container and enforce the symbol ceiling on both arches.
