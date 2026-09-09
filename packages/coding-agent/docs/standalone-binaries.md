# Standalone binaries

The macOS and Linux release archives contain `prime-agent` and its support files. Normal application execution does not require Node, npm, or Bun. Keep the archive contents together: moving only the executable breaks asset and Python runtime discovery. Linux archives target glibc; Alpine/musl and Windows are outside this distribution.

Download `prime-agent-<version>-<platform>.tar.gz` and `SHA256SUMS` from the same release. Platforms are `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`. Verify the selected archive's SHA-256 against that inventory, then extract it into its own directory and run `./prime-agent --help`.

The Python tool uses the existing managed CPython setup. Its first use requires uv and network access to install Python and Python dependencies. The archive includes the matching `prime-agent-runtime` sources and built-in Python skills. It contains no prebuilt virtual environment or `node_modules` directory. External tools and extension-specific dependencies retain their own requirements.

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

The current installer and update lifecycle remain unchanged. Standalone archive users download and extract a new version manually. Homebrew packaging and automated binary installation/update are separate work.
