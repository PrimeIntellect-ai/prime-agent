# Releasing Prime Agent

This page describes how a Prime Agent release happens: what you do, what CI does, and what to check.
For the trust model behind it, see [Release security](release-security.md).

## In one sentence

A release is a merged pull request that bumps the version; everything after the merge is automated,
and anything that is *not* an approved version-bump pull request stops and waits for a reviewer.

## The normal release

1. **Prepare the release.** Run `npm run release:patch` (fixes and features) or
   `npm run release:minor` (breaking changes). `npm run release:major` exists but is not used: by
   policy Prime Agent has no major releases. The script creates a `release/vX.Y.Z` branch first,
   then bumps the version in lockstep across the published packages, folds the `.changes/*.md`
   fragments into the changelogs, commits, pushes the branch, and opens the release pull request. It
   does not push `main`, does not create the tag, and does not publish anything. It refuses to run
   unless the checkout is `main` at `origin/main`, and refuses if that release branch already exists.
2. **Get the pull request reviewed and merge it.** This is the approval gate. The release workflow
   later confirms that the merge commit belongs to a merged pull request whose *current* review
   state includes an approval from a human; dismissed approvals, outstanding change requests, and
   bot approvals do not count.
3. **CI takes over.** The `Release Prime Agent` workflow runs on the merge, in this order:

   | Job | What it does | Secrets |
   |---|---|---|
   | `context` | Resolves the version and decides whether the release may publish unattended | none |
   | `standalone` | Compiles the four platform binaries with Bun and signs macOS binaries ad hoc | none |
   | `build` | Packs the release archives and npm-shaped tarballs | none |
   | `validate-macos` | Re-verifies macOS signatures and matches every `executableSha256` receipt | none |
   | `assemble` | Renders the installer, verifies receipts, produces the final artifact set | none |
   | `sign` | cosign keyless signature over `SHA256SUMS`, SBOM per archive, build provenance | OIDC only |
   | `github-release` | Refuses an existing tag at another commit, creates a **draft** release (no tag yet), records GitHub's asset digests | `GITHUB_TOKEN` |
   | `publish-r2` | Verifies every artifact against those digests, uploads **only** the immutable `releases/vX.Y.Z/` objects, refuses to overwrite, reads back. Moves no pointer. | R2, step-scoped |
   | `verify` | Clean runner: downloads the immutable objects from the public URL, verifies the cosign signature and digests, runs the binary | none |
   | `finalize-release` | Re-checks the draft assets and the tag, publishes the release (the `vX.Y.Z` tag appears here), proves the tag points at the release commit, then as its **last step** moves `stable`, `latest.json` and `install.sh` | `GITHUB_TOKEN`, then R2 step-scoped |
   | `pack-npm` | Unprivileged: builds the workspace and stages the registry packages from the verified archives | none |
   | `publish-npm` | No checkout: re-hashes each tarball against the manifest, publishes over OIDC with provenance | OIDC only |
   | `tap-bump` | Opens the Homebrew formula bump | tap token |

4. **Watch `verify`.** It downloads what a user would download and fails the run if anything does not
   match. Until `finalize-release` completes, nothing a user follows refers to the new version: the
   channel pointers, `install.sh`, the GitHub release and the tag are all untouched. Only the
   content-addressed `releases/vX.Y.Z/` objects exist, and `verify` has to accept them first.

## Nightly (beta)

Every merge to `main` publishes a beta build. It runs in its own job with its own credential and can
only write the beta prefix and the beta pointers. It cannot write `stable`, `latest.json`, or
`install.sh`, and it creates no version tag. Nightly never waits for a reviewer.

Install or test a nightly build with the beta channel:

```sh
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | PRIME_AGENT_RELEASE_CHANNEL=beta sh
```

## Break-glass releases

Some publications cannot point at an approved release pull request:

- `workflow_dispatch` with a `release_tag` input
- a version bump that reached `main` without a pull request
- a retry of a failed release that rides on an unrelated merge

These still run, but `context` routes them to the `release-manual` environment, which requires a
reviewer who did not trigger the run. Two jobs run in that environment (`publish-r2` and
`finalize-release`), so a break-glass release asks for approval twice: once before anything is
uploaded, once before anything becomes public. Pushing a `v*` tag does **not** start a release at all; the tag
is an output of the release, never an input.

## If a release fails

- **Before or during `publish-r2`, or in `verify`:** nothing a user can reach has changed. The
  immutable objects may exist under `releases/vX.Y.Z/`, but no pointer, installer, release or tag
  refers to them. Uploads refuse to overwrite, so a retry is safe.
- **In `finalize-release`:** the tag and GitHub release may exist before the pointers move. If the
  final pointer step failed, re-run it; it only writes pointers to objects `verify` already accepted.
- **After the pointers move:** the release is live and immutable. Ship a new patch version; do not
  rewrite a published version.
- A version whose tag already points at a different commit is refused outright.

## Checking a published release by hand

```sh
BASE=https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev
VERSION=0.9.5
curl -fsSLO "$BASE/releases/v$VERSION/SHA256SUMS"
curl -fsSLO "$BASE/releases/v$VERSION/SHA256SUMS.sigstore.json"
cosign verify-blob \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/PrimeIntellect-ai/prime-agent/.github/workflows/build-binaries.yml@refs/heads/main" \
  SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

`prime-agent update` performs the equivalent check automatically and refuses to install anything that
fails it.

## Operator setup

The workflow expects these GitHub environments. Each holds one credential and is limited to `main`:

| Environment | Holds | Notes |
|---|---|---|
| `release-r2` | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT_URL` | unattended production publishing |
| `release-manual` | the same R2 secrets | required reviewers, self-review disabled |
| `nightly-r2` | `NIGHTLY_R2_*` | a token scoped to the beta prefix only |
| `release-npm` | nothing | npm trusted publishing over OIDC |
| `release-homebrew` | `HOMEBREW_TAP_TOKEN` | formula bump pull requests |

Two repository variables act as switches: `NPM_PUBLISH_ENABLED` enables npm publishing, and
`HOMEBREW_TAP_REPO` enables the tap bump. Both jobs do nothing until they are set.
