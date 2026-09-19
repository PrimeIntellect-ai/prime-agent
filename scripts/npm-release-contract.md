# npm release contract

How the registry channel is built and what CI must call. Nothing in this document publishes; the
packer only stages files. Publishing happens in one privileged CI job that runs no repository code.

## Packages

| Package | Kind | Contents |
|---|---|---|
| `prime-agent` | front door (canonical, unscoped) | `bin/prime-agent.cjs` shim, `optionalDependencies` on the four platform packages pinned to the exact version, per-platform `executableSha256` receipts in `primeAgent.platforms` |
| `@primeintellect/prime-agent` | front door mirror | identical content, name only differs |
| `@primeintellect/prime-agent-darwin-arm64` | platform | one compiled binary plus its sibling assets under `bin/`, `os: ["darwin"]`, `cpu: ["arm64"]`, `receipts.json` |
| `@primeintellect/prime-agent-darwin-x64` | platform | same, `os: ["darwin"]`, `cpu: ["x64"]` |
| `@primeintellect/prime-agent-linux-arm64` | platform | same, `os: ["linux"]`, `cpu: ["arm64"]` |
| `@primeintellect/prime-agent-linux-x64` | platform | same, `os: ["linux"]`, `cpu: ["x64"]` |
| `@primeintellect/prime-agent-ai` | library | `packages/ai` build output |
| `@primeintellect/prime-agent-core` | library | `packages/agent` build output |
| `@primeintellect/prime-agent-tui` | library | `packages/tui` build output |

Properties that hold for every package:

- no `scripts` at all, so `npm install` executes nothing from us (`--ignore-scripts` changes nothing);
- `publishConfig` = `{ access: "public", registry: "https://registry.npmjs.org", provenance: true }`;
- a `repository` field pointing at `PrimeIntellect-ai/prime-agent`, which npm requires for provenance;
- dependencies are registry ranges only. Tarball, git, file and workspace specifiers are rejected by
  `assertRegistryDependencies()` in `scripts/lib/internal-dependencies.mjs`.

Library packages keep importing `@earendil-works/pi-*` in their compiled output, so their internal
dependencies are npm aliases: `"@earendil-works/pi-ai": "npm:@primeintellect/prime-agent-ai@^<version>"`.
npm, pnpm, yarn and bun all understand that form. The R2 channel keeps its tarball URLs and is
untouched.

## Build step (unprivileged job)

```bash
node scripts/pack-npm-packages.mjs \
  --binary-dir packages/coding-agent/binaries \
  --version "${VERSION}" \
  --receipts release/artifacts/latest.json \
  --out-dir release/npm
```

| Flag | Meaning |
|---|---|
| `--binary-dir <dir>` | required; holds `darwin-arm64/`, `darwin-x64/`, `linux-arm64/`, `linux-x64/` from the standalone build |
| `--version <x.y.z>` | release version; defaults to `PRIME_AGENT_VERSION`, then `packages/coding-agent/package.json` |
| `--receipts <file>` | optional `latest.json` / `beta.json` / `binaries.json` from the R2 packer. Every `executableSha256` must match the compiled binary or the command fails. Use it so the npm artifact and the R2 artifact assert the same hash |
| `--out-dir <dir>` | staging root, default `release/npm` |
| `--scope <@scope>` | default `@primeintellect` |
| `--front-door <name>` | default `prime-agent` |
| `--packages-dir <dir>` | workspace root, default `packages/` (tests only) |
| `--skip-pack` | stage directories without running `npm pack` |

Output:

```
release/npm/prime-agent/                                 staged package directory
release/npm/@primeintellect/prime-agent/
release/npm/@primeintellect/prime-agent-<platform>/      (x4)
release/npm/@primeintellect/prime-agent-{ai,core,tui}/
release/npm/artifacts/<npm-pack-name>.tgz                one tarball per package
release/npm/manifest.json                                { version, publishOrder, packages[] }
```

`manifest.json` records `name`, `kind`, `directory`, `tarball` and `sha256` per package, plus
`publishOrder`. The publish job should upload `release/npm/artifacts/` as an artifact and consume
only that.

## Publish step (privileged job, `release-npm` environment)

```yaml
permissions: { id-token: write, contents: read }   # OIDC trusted publishing + provenance
```

No checkout, no `npm ci`, no repository script. Download the artifact, then publish each tarball in
`manifest.json.publishOrder`:

```bash
npm publish "release/npm/artifacts/${TARBALL}" --provenance --access public --ignore-scripts
```

Order, and why it is not negotiable:

1. `@primeintellect/prime-agent-darwin-arm64`
2. `@primeintellect/prime-agent-darwin-x64`
3. `@primeintellect/prime-agent-linux-arm64`
4. `@primeintellect/prime-agent-linux-x64`
5. `@primeintellect/prime-agent-ai`
6. `@primeintellect/prime-agent-core` (depends on `-ai`)
7. `@primeintellect/prime-agent-tui`
8. `prime-agent`
9. `@primeintellect/prime-agent`

The front door pins the platform packages exactly, so it must be published last: a failure in the
middle then leaves a usable registry state instead of a front door that points at versions nobody can
install. `-ai` precedes `-core` for the same reason. The packer computes this order from the
dependency graph and writes it to `manifest.json`; the job must follow the file, not a hard-coded list.

## What a consumer gets

`npm i -g prime-agent` installs the shim plus exactly one platform package. The shim resolves that
package (`require.resolve`, then a `node_modules` walk for pnpm/yarn layouts), makes the binary
executable if the installer dropped the bit, and executes it with the caller's arguments, exit code
and signals. `preferUnplugged` keeps yarn from leaving the binary inside a zip. Errors are explicit:
an unsupported platform lists the supported ones, a missing platform package explains that optional
dependencies were skipped and prints the exact install command.

`PRIME_AGENT_VERIFY_BINARY=1` hashes the executable and compares it with the receipt in both the
platform package and the front door before exec, and fails closed on mismatch. It is opt-in because
hashing a ~100 MB executable on every launch is not free; the always-on integrity controls are npm's
own lockfile hash, registry signatures, and provenance (`npm audit signatures`).

## One-time npm setup (manual, owner account)

1. Create the `@primeintellect` org on npmjs.com.
2. Reserve every name above with a `0.0.0` placeholder publish, plus the unscoped defensive names
   (`prime-agent-ai`, `prime-agent-core`, `prime-agent-tui`, `prime-agent-<platform>`) so nobody can
   squat the strings the installer and README already teach.
3. Configure a trusted publisher per package: repository `PrimeIntellect-ai/prime-agent`, workflow
   `.github/workflows/build-binaries.yml`, environment `release-npm`. Trusted publishing is configured per
   package and **the package must already exist**, which is why step 2 comes first.
4. After the trusted publishers exist, delete any classic automation tokens; the publish job must
   hold no npm credential.
