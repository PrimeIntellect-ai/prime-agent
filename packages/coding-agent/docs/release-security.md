# Release security

This page explains what protects a Prime Agent release, what each control stops, and how to verify a
release yourself. For the day-to-day procedure, see [Releasing Prime Agent](releasing.md).

## The problem this solves

Users receive Prime Agent through a shell installer, a self-updater, npm, and Homebrew. Every one of
those paths ends in executing our code. The release pipeline therefore has one job: make it
impossible for a single stolen credential, a single malicious dependency, or a single unreviewed
commit to put code on a user's machine.

## Trust model

| Stage | Trusted by | Protected by |
|---|---|---|
| Source | reviewers | branch protection, pull-request review, CODEOWNERS |
| Build | nobody | build jobs hold no credentials and run with `npm ci --ignore-scripts` |
| Signing | Sigstore | keyless cosign, identity bound to this repository, workflow file and ref |
| GitHub release | GitHub | asset digests recorded by GitHub, release drafted before anything is public |
| R2 | Cloudflare | objects verified against GitHub's digests, immutable prefixes, read-back |
| Install | the user | `SHA256SUMS`; its cosign signature when `cosign` is on `PATH` (fail closed on mismatch, required with `PRIME_AGENT_REQUIRE_SIGNATURE=1`); otherwise TLS and the same-origin checksum only |
| Update | the running binary | signature verification is mandatory and fails closed |

The key idea is that **no single origin can assert its own integrity**. R2 serves the artifact, but
the digest was recorded by GitHub and the signature was minted by Sigstore. An attacker who holds the
R2 credential and nothing else cannot produce a release that any existing installation will accept.

## Controls

### Releases come only from an approved pull request

`scripts/resolve-release-context.mjs` resolves the head commit to a pull request that was actually
merged as that commit (`merged_at` set, `merge_commit_sha` equal, base is the default branch) and
evaluates the pull request's **current** review state: the latest review per human reviewer must
include an approval at the merged head, no human may have an outstanding change request, dismissed
reviews do not count, and bot reviews are ignored. Direct pushes, manual dispatches, stale or
dismissed approvals, and retries riding an unrelated merge are routed to the `release-manual`
environment, which requires a reviewer who did not trigger the run.

Pushing a `v*` tag does not start a release. A draft GitHub release creates no tag; the tag appears
when `finalize-release` publishes the release, after `verify` accepted the artifacts, and the job
then proves the tag points at the release commit. An existing `v*` tag at any other commit fails the
release before anything is drafted.

### Credentials never share a machine with repository code

The publishing jobs (`github-release`, `publish-r2`, `finalize-release`, `publish-npm`) do not check
out the repository, install dependencies, or run project scripts. They download artifacts, verify
them, and upload them. R2 credentials are declared at **step** level, so they are absent from every
other step in the same job. Build jobs, which do run repository and dependency code, hold no
credentials at all - including `pack-npm`, which builds the registry packages and hands tarballs to
`publish-npm` by artifact. `scripts/check-release-workflow.mjs` enforces this in CI: it derives which
jobs are credential-bearing (any environment, any write permission, or any secret other than exactly
`GITHUB_TOKEN`) and fails if any of them checks out code, installs packages, invokes anything under
the repository, changes directory anywhere but a downloaded-artifact directory, sets a
`working-directory`, edits `PATH` or interpreter startup variables, or runs shell constructs whose
target it cannot prove (`sh -c`, `eval`, command substitution, `xargs`, piping into an interpreter).
Every job the checker derives as credential-bearing must declare a GitHub environment; the only
exemptions are jobs proved to hold nothing but a read-only or draft-only `GITHUB_TOKEN`, and any job
with `contents: write` must be one of the named release jobs or depend on `verify`. It also holds a
per-job command allowlist for those jobs (coreutils, `jq`, `tar`, `curl` with
`--proto '=https'`, `gh`, plus `aws`/`cosign`/`npm`/`git` only where that job needs them; no
interpreter of any kind), pins every `aws` call to `--endpoint-url "$R2_ENDPOINT_URL"`, and holds an
allowlist for R2 writes: every upload destination must be a literal key under the immutable
`releases/v<version>/` prefix, sources must be normalised paths inside a downloaded artifact
directory, and the four channel pointers may be written only by the last step of `finalize-release`.

Beta builds are signed the same way. The `sign` job also signs the beta `SHA256SUMS` with the same
identity (`build-binaries.yml` on the default branch, which the updater's pin accepts), and the beta
job verifies that bundle before uploading it next to the checksums, so a compiled nightly install
updates through exactly the same verification as a stable one.

The `standalone` build jobs hold `id-token: write` but no secrets. They use it to sign a **test-only**
build so the CI end-to-end test can exercise `prime-agent update` against an actual signed archive.
That test binary is compiled with a build-time signer override naming the standalone job's own
certificate identity, is marked `(test signer override)` in its output, never leaves the runner's
temporary directory, and cannot reach the release artifact. The release binary has no runtime or
build-time path to change its pinned identity; the checker asserts the override flag appears only in
that one test step. A standalone job's certificate names `standalone-binaries.yml`, never the release
workflow, so nothing it signs can satisfy the release binary's pin.

### Dependency install scripts do not run on release machines

Release and build jobs use `npm ci --ignore-scripts`, so a compromised dependency's `postinstall`
does not run on the machine that produces the binaries. One exception is deliberate and checked:
`npm rebuild esbuild` runs esbuild's own install script, because the bundler cannot work without its
platform binary. That means a compromised **esbuild** (a direct, SHA-pinned dependency in the
lockfile) could still execute on a build runner. Build runners hold no credentials, and every artifact
they produce is verified downstream, so the blast radius is the build output itself - which is why
the checker allows `npm rebuild` for exactly that one package and nothing else.

### Nightly cannot reach stable

Beta publishing runs in a separate job with a separate credential scoped to the beta prefix. It
cannot write `stable`, `latest.json`, or `install.sh`. Changing what stable users receive requires an
approved release.

### Artifacts are signed, and the checksum file is the signed object

`sign` produces a keyless cosign signature over `SHA256SUMS`, published as
`SHA256SUMS.sigstore.json`, plus an SPDX SBOM per archive and a build provenance attestation. Signing
the checksum manifest rather than each artifact means one signature covers the whole release.

The signature is only accepted when the certificate says all of the following:

- repository `PrimeIntellect-ai/prime-agent`
- workflow `.github/workflows/build-binaries.yml`
- ref `refs/heads/main` or a `refs/tags/vX.Y.Z` tag
- OIDC issuer `https://token.actions.githubusercontent.com`
- runner environment `github-hosted`

Without the workflow and ref pin, any workflow in the repository could mint a signature that looks
valid. The pinned values live in `packages/coding-agent/src/utils/release-trust.ts`.

### Publication is verified, immutable, and ordered

`publish-r2` verifies every artifact against the digest GitHub recorded, refuses to overwrite an
existing object under `releases/vX.Y.Z/`, reads each object back, and writes **nothing else**: no
channel pointer, no installer. `verify` then downloads those immutable objects from the public URL on
a clean runner and checks the signature, the digests and the binary. Only after that does
`finalize-release` publish the GitHub release, prove the tag, and - as its last step - move
`stable`, `latest.json` and `install.sh`.

So until `finalize-release` completes, nothing a user follows refers to the new version. A failure
before or during `verify` leaves only content-addressed objects that no pointer names. A failure
inside `finalize-release` can leave the tag and GitHub release without the pointers; re-running the
pointer step is safe because it only names objects `verify` already accepted.

### The self-updater verifies, and fails closed

`prime-agent update` downloads `SHA256SUMS` and its signature bundle, verifies the bundle offline
against an embedded Sigstore trusted root, checks the signer identity against the pinned values, and
only then compares the archive digest. A missing bundle, an invalid signature, or a foreign identity
aborts the update. `PRIME_AGENT_DOWNLOAD_BASE_URL` can move the download origin for development but
cannot relax or replace verification.

This matters because the updater, not the installer, is how most users receive most releases.

### The installer verifies when it can, and says so when it cannot

`install.sh` downloads `SHA256SUMS.sigstore.json` next to `SHA256SUMS` and refuses to continue if the
bundle is missing. When `cosign` is on `PATH` it verifies the bundle against the release workflow's
identity and fails closed on any mismatch. A POSIX shell script cannot verify a Sigstore bundle by
itself, so **without cosign a fresh `curl | sh` install rests on TLS and the same-origin checksum**,
and the installer prints exactly that. Set `PRIME_AGENT_REQUIRE_SIGNATURE=1` to make a missing
`cosign` a hard failure. From the first `prime-agent update` onward the compiled binary verifies every
release itself, with no fallback.

### Installations know who owns them

A Homebrew or npm installation is detected before the compiled-binary path, so those copies are
directed to `brew upgrade` or their package manager instead of overwriting a managed installation.

## What each attacker can do

| Attacker | Before | After |
|---|---|---|
| Holds the R2 credential | replace artifact, checksums, manifest and installer | cannot match GitHub's digests, cannot forge the signature; existing installs and cosign-equipped fresh installs refuse it. A fresh install on a machine without cosign remains exposed until its first update |
| Has repository write access | push a `v*` tag and ship a release unattended | a pushed tag does nothing; publishing needs an approved version-bump pull request or a reviewer |
| Compromises a build dependency | execute during the release build beside credentials | install scripts do not run (except esbuild's, see above), and build jobs hold no credentials |
| Steals a nightly credential | overwrite the stable channel | limited to the beta prefix |
| Compromises an npm token | publish a malicious package | there is no token; publishing is OIDC with provenance |

Out of scope, deliberately: a malicious change that passes code review. That is what review is for.
The pipeline guarantees that what users receive is what the repository approved, not that the
approval was wise.

## Verifying a release yourself

```sh
BASE=https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev
VERSION=0.9.5
PLATFORM=linux-x64

curl -fsSLO "$BASE/releases/v$VERSION/SHA256SUMS"
curl -fsSLO "$BASE/releases/v$VERSION/SHA256SUMS.sigstore.json"
curl -fsSLO "$BASE/releases/v$VERSION/prime-agent-$VERSION-$PLATFORM.tar.gz"

cosign verify-blob \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/PrimeIntellect-ai/prime-agent/.github/workflows/build-binaries.yml@refs/heads/main" \
  SHA256SUMS

sha256sum --check --ignore-missing SHA256SUMS
```

The same artifacts are attached to the GitHub release, so you can compare the two origins. Build
provenance can be checked with `gh attestation verify <file> --repo PrimeIntellect-ai/prime-agent`,
and published npm packages carry provenance visible through `npm audit signatures`.

## Reporting problems

Report suspected release or supply-chain issues privately; see [SECURITY.md](../../../SECURITY.md).
