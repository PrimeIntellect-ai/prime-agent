# Standalone binaries

The macOS and Linux release archives contain `prime-agent` and its support files. Normal application execution does not require Node, npm, or Bun. Keep the archive contents together: moving only the executable breaks asset and Python runtime discovery. Linux archives target glibc; Alpine/musl and Windows are outside this distribution.

Download `prime-agent-<version>-<platform>.tar.gz` and `SHA256SUMS` from the same release. Platforms are `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`. Verify the selected archive's SHA-256 against that inventory, then extract it into its own directory and run `./prime-agent --help`.

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

The published installer defaults to the compiled archive on macOS 13+ and glibc Linux, on ARM64 or x64. It checks the exact release checksum, rejects unsafe archive entries, validates required assets, and runs the executable before activating it. Machines outside those targets use the existing Node installer; an executable that cannot run also falls back to Node. A failed checksum never triggers a fallback.

Pinning a release whose checksum inventory only advertises npm packages uses the verified Node installer. This preserves installation of releases published before compiled archives existed. Missing or invalid compiled checksums, an incomplete compiled release, and failed archive downloads remain errors; `binary` mode never falls back.

Set `PRIME_AGENT_INSTALL_METHOD=node` to explicitly keep the Node installation, or `binary` to require the compiled application. `PRIME_AGENT_INSTALL_DIR` overrides the managed root (default `$XDG_DATA_HOME/prime-agent` or `~/.local/share/prime-agent`); `PRIME_AGENT_BIN_DIR` overrides the public command directory (default `~/.local/bin`). Both must be absolute. Existing unrelated commands are never replaced. `PRIME_AGENT_INSTALL_LINK=0` installs without a public link.

Each release keeps its executable and assets together under `releases/`. The stable `bin/prime-agent` link changes only after validation, and `bin/previous` retains the earlier release. The installer serializes changes with `.install-lock`; normal interruption cleans up the lock. After a forced kill, confirm its recorded process is no longer running before removing the stale lock. User data remains in `~/.prime/agent`.

Reinstalling the same archive creates a fresh release directory with a unique suffix, so it can repair missing or changed assets without modifying files used by existing processes. Old release directories are retained; there is no automatic garbage collection yet.

The installer still shows download and verification progress and can prepare Python. Compilation removes JavaScript dependency installation; Python and external tools still need preparation. Set `PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=0` to defer Python setup.

Existing npm installations and the in-app updater are handled by the next layers of the rollout. Homebrew packaging remains separate work.
