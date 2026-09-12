# Standalone binaries

The macOS and Linux release archives contain `prime-agent` and its support files. Normal application execution does not require Node, npm, or Bun. Keep the archive contents together: moving only the executable breaks asset and Python runtime discovery. Linux archives target glibc; Alpine/musl and Windows are outside this distribution.

On macOS, use the published installer:

```sh
curl --proto '=https' --proto-redir '=https' -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

The current macOS archives are not Developer ID signed or notarized. A browser-downloaded archive may retain quarantine metadata and be blocked by Gatekeeper, so manual macOS archive installation is not supported yet. Do not bypass Gatekeeper; use the installer until signed and notarized downloads are available.

On Linux, download `prime-agent-<version>-<platform>.tar.gz` and `SHA256SUMS` over HTTPS from the same release. Platforms are `linux-arm64` and `linux-x64`. Check the selected archive's SHA-256 against that inventory, extract it into its own directory, and run `./prime-agent --help`.

The Python tool uses the existing managed CPython setup. Its first use requires uv and network access to install Python and Python dependencies. The archive includes the matching `prime-agent-runtime` sources and built-in Python skills. It contains no prebuilt virtual environment or `node_modules` directory. External tools and extension-specific dependencies retain their own requirements.

On Intel macOS, the current `cryptography` dependency has no compatible wheel and is built from source during Python setup. This also requires Xcode Command Line Tools, Rust, and OpenSSL development libraries; see the [cryptography build requirements](https://cryptography.io/en/stable/installation/#building-cryptography-on-macos). These Python dependency requirements also apply to the existing Node distribution. Shipping Python dependency wheels is separate work.

## Build

Development continues to use Node, npm, `package-lock.json`, TypeScript declarations/checks, and Vitest. Install locked dependencies with `npm ci`. Install Bun **1.4.0** separately as the binary compiler, or point `BUN_BINARY` at that version's executable.

From `packages/coding-agent`:

```sh
npm run build:binary
npm run build:binary -- --platform all
```

The first command builds the native platform; the second cross-compiles all four targets. A single target can also be selected with `--platform linux-arm64`. Both commands compile the workspace TypeScript packages using the committed model catalog, then bundle the existing Bun CLI entry. They do not install dependencies or change the lockfile. Output goes to `packages/coding-agent/binaries/<platform>/`.

Assemble local archives from the repository root:

```sh
node scripts/assemble-release-archives.mjs packages/coding-agent/binaries /tmp/prime-agent-archives 0.9.4
```

This creates platform tarballs, `SHA256SUMS`, and `binaries.json`. The version argument sets the archive's package metadata without changing the checkout or the compiled executable. Each archive has a flat layout:

```text
prime-agent
install.sh
package.json
LICENSE, README.md, CHANGELOG.md
prime-agent-runtime/
skills/
theme/
assets/
export-html/
docs/
examples/
photon_rs_bg.wasm
```

## Validation and release integration

From `packages/coding-agent`, run the artifact tests against an archive for the host platform:

```sh
PRIME_AGENT_TEST_ARCHIVE=/tmp/prime-agent-archives/prime-agent-0.9.4-darwin-arm64.tar.gz \
PRIME_AGENT_TEST_UV="$(command -v uv)" \
npx tsx ../../node_modules/vitest/dist/cli.js --run test/compiled-artifact.test.ts
```

The suite extracts outside the checkout, creates isolated homes and a PATH without JavaScript runtimes, and exercises provider requests against a local HTTP/2 server, extension and skill loading, Photon image resizing, HTML export, RPC, managed Python, and daemon shutdown. It never uses real provider credentials. Python bootstrap requires network access. Other tests skip this suite when `PRIME_AGENT_TEST_ARCHIVE` is unset.

CI builds and tests natively on all four target platforms. Before testing, it moves the build checkout so absolute build-time paths and its original `node_modules` cannot satisfy missing runtime files. Cross-compilation alone is not native execution evidence.

The release workflow consumes those tested artifacts, adds the stable or beta package version, and includes all four archives in the existing aggregate `SHA256SUMS`. Existing npm tarballs and manifest fields remain. The `binaries` array adds `{ platform, file, sha256 }` entries; each file lives under `releases/v<version>/`. Stable/beta pointers retain their existing routing. Production and beta uploads use the same archives for GitHub and R2.

## Installation

The published installer defaults to the compiled archive on macOS 13+ and glibc Linux, on ARM64 or x64. It requires an HTTPS release base, allows redirects only to HTTPS, checks the exact release checksum, rejects unsafe archive entries, validates required assets, and runs the executable before activating it. Machines outside those targets use the existing Node installer; an executable that cannot run also falls back to Node. A failed checksum never triggers a fallback.

The archive and `SHA256SUMS` inventory are served by the same release origin. The checksum detects corruption or inconsistent content but is not an independent signature and does not protect against a compromised origin; HTTPS authentication of the configured origin is the trust boundary.

Pinning a release whose checksum inventory only advertises npm packages uses the checksummed Node installer. This preserves installation of releases published before compiled archives existed without requiring newer release metadata. Missing or invalid compiled checksums, an incomplete compiled release, and failed archive downloads remain errors; `binary` mode never falls back.

Set `PRIME_AGENT_INSTALL_METHOD=node` to explicitly keep the Node installation, or `binary` to require the compiled application. `PRIME_AGENT_INSTALL_DIR` overrides the managed root (default `$XDG_DATA_HOME/prime-agent` or `~/.local/share/prime-agent`); `PRIME_AGENT_BIN_DIR` overrides the public command directory (default `~/.local/bin`). Both must be absolute. Existing unrelated commands are never replaced. `PRIME_AGENT_INSTALL_LINK=0` installs without a public link.

Each release keeps its executable and assets together under `releases/`. The stable `bin/prime-agent` link changes only after validation, and `bin/previous` retains the earlier release. The installer serializes changes with `.install-lock`; normal interruption cleans up the lock. Activation also records a durable `.activation-state` intent before changing either launcher. After a forced kill, confirm the recorded installer process is no longer running before removing the stale lock; the next installer or rollback invocation then completes or clears an unambiguous interrupted activation before making another change. User data remains in `~/.prime/agent`.

Reinstalling the same archive creates a fresh release directory with a unique suffix, so it can repair missing or changed assets without modifying files used by existing processes. Cleanup runs only after the replacement is healthy.

After a healthy activation or activation recovery, the installer removes abandoned `.install.<suffix>` staging directories while holding the installation lock. It also removes obsolete managed release directories when `lsof` can inspect the release executable and reports it unused. Current, previous, live, malformed, symlinked, and otherwise uncertain directories are retained. If `lsof` is unavailable or cannot inspect a candidate, that release is kept for a later installer run or manual review; no user-data or legacy Node/npm directory is part of this maintenance.

The installer still shows download and verification progress and can prepare Python. Compilation removes JavaScript dependency installation; Python and external tools still need preparation. Set `PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=0` to defer Python setup.

## Migration from npm

Releases containing native archives also include a bridge at the existing npm CLI entrypoint. An old version can install that release through its existing updater; its next foreground interactive launch downloads and verifies the compiled application. Installer progress is written to the terminal without changing application stdout. Informational commands, piped and machine-readable runs, internal workers, daemon launches, and restart coordinators do not start a migration download, so automation and liveness checks remain immediate. Internal entrypoints can still reuse an already compatible compiled release after command handoff. The bridge only migrates conventional global npm installs whose command still points to that package. It then transfers that owned command link to the managed native launcher, so subsequent launches do not require Node. Existing Node files and shared runtimes are retained.

Homebrew, source checkouts, other package-manager layouts, read-only prefixes, and unsupported platforms keep the Node route. `PRIME_AGENT_INSTALL_METHOD=node` disables migration. Offline launches defer downloads. Installation failures keep the Node application usable and suppress automatic retries for 24 hours; set `PRIME_AGENT_MIGRATE_RETRY=1` for an explicit earlier retry. Cancelling migration does not start that retry window. Migration also works when npm lifecycle scripts were disabled.

Already-released updaters pass the package URL directly to npm. npm 12's default remote-package policy can reject that download with `EALLOWREMOTE` before this bridge runs; the installed Node application remains usable. For a trusted release source, retry with `NPM_CONFIG_ALLOW_REMOTE=all prime-agent update`, then launch `prime-agent` normally to migrate. This setting applies only to that command and its children, without changing global npm configuration. Fresh compiled installs and compiled updates do not use npm; unsupported hosts remaining on Node can encounter this policy on later updates too.

An interactive update from an older Node release can restore its session on a Node daemon worker before the foreground launcher finishes migration. The public command then runs Bun, while that resident worker keeps running until the daemon is restarted. Resuming the saved conversation after shutdown starts it on Bun; migration does not forcibly replace a healthy worker solely to change runtimes.

Migration reuses an equal or newer managed release. It also checks the captured active release after acquiring the installer lock: if another install wins the race, migration defers to the Node application instead of overwriting that install. The next launch can adopt the newer managed release.

Before reusing a compiled release, the bridge checks the installer's OS/architecture compatibility result and probes the executable's version. Unsupported hosts quietly retain Node. A broken probe or a mismatch with installed release metadata reports a rate-limited diagnostic with reinstall and opt-out guidance. Command handoff captures the npm link and creates the native link exclusively, so a concurrent npm command wins instead of being overwritten. The public path can be briefly absent during this one-time transfer. If abrupt termination prevents restoration, the captured command remains under the adjacent `.prime-agent-link-*` directory for recovery; the versioned application and user data remain intact.

Failed automatic migrations retry after 24 hours; `PRIME_AGENT_MIGRATE_RETRY=1` retries immediately. Homebrew packaging remains separate work.

## Updates and rollback

Run `prime-agent update` or `/update` to install the latest version on the current stable or beta channel. Managed compiled installations require a matching platform entry in the release manifest and verify its SHA-256 against both the release checksums and downloaded archive. Failed downloads or validation leave the current executable and assets active. Unmanaged archives must be updated through their original installer.

Updates retain the previous release, preserve user configuration and sessions, and use the existing busy-session confirmation and daemon restart coordination. Relaunches resolve the stable launcher after activation, so the new process runs the updated application. The installer checks that the active release has not changed since the update was planned and serializes activation with its installation lock.

Run `prime-agent update --rollback` or `/update --rollback` to restore the previous local release without downloading anything. Its managed path, checksum marker, package version, install source, required assets, executable version, and help probe are validated before switching. These checks establish internal installation consistency; they do not cryptographically re-verify every installed file against the original archive. A second rollback restores the release you just left when that release remains healthy. Rollback requires a retained release and applies only to managed compiled installations. `--force` permits reinstalling the version selected by the release channel.

If the active release is damaged, rollback validates and activates the healthy previous release without retaining the damaged one as a rollback target. Update planning can use the intact previous release's installer when it declares support for damaged-release recovery. Older retained installers instead give published-installer recovery guidance. If the current executable cannot start, rerun the published installer with `PRIME_AGENT_INSTALL_DIR` set to the managed root. Repairs preserve an existing healthy previous release.

Normal interruption during rollback finishes retaining the release being left. A forced kill can leave the launcher changes incomplete and the installation lock stale, but it also leaves the activation intent needed for the next installer invocation to recover the exact pair. Recovery refuses an unexpected or invalid link state and reports the state file instead of guessing.

## Coverage and recovery limits

Native CI runs the extracted archives on macOS 15 (ARM64 and x64) and Ubuntu 24.04 (ARM64 and x64). It tests installation, forced reinstall, later update, offline rollback, daemon replacement, runtime assets, RPC, and managed Python without JavaScript runtimes on the application PATH. The installer selects macOS 13+ and compatible glibc Linux, but these selection checks do not constitute execution testing on every older OS release.

Focused regressions cover migration without lifecycle scripts, incompatible existing binaries, deferred migration during internal daemon startup, competing installs and npm command handoffs, checksum/manifest failures, rollback metadata and executable-version mismatches, interrupted activation recovery, conservative release retention, and orphan staging cleanup. Normal installer hangups release the lock. A forced kill still requires confirming and clearing its stale lock before recovery can run; complete filesystem power-loss, disk-exhaustion, ACL, and network-filesystem fault testing is outside this matrix.

Rollback restores application files, not arbitrary future user-data schema changes. SHA-256 verification detects archive/metadata disagreement; it does not introduce an independent release-signing authority. Shell aliases and earlier competing PATH entries are not rewritten. The Node fallback package remains on disk, as do compiled releases whose use cannot be ruled out safely.
