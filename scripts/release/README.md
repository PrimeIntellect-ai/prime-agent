# Release publication

Eligible main commits still produce unique beta versions and tags through
`nightly.yml`. `release.yml` retains the five-platform build/reuse routes and
publishes versioned installer payloads to R2. Only stable tags create individual
GitHub releases; beta tags refresh the single prerelease named `nightly`.

For future beta versions, the public R2 prefix
`releases/v<version>/` retains the entire published payload: platform tarballs,
Linux debug decoders, the npm migration bridge, SHA256SUMS, merged manifest,
beta.json, and per-target SPDX SBOMs. Audit files upload before channel pointers
advance, even when a newer main commit has superseded the build. The existing
provenance attestation step continues to cover tarballs and decoders. The rolling
nightly release also carries the full current payload and checksums.

Installers and native/npm updaters keep using the R2 channel manifests and
versioned payload paths anonymously; they do not require per-beta GitHub release
objects. Consumers of `/releases/download/v<beta>/...` must use the public R2
versioned prefix for future beta builds, or `nightly` for its current payload.
Stable GitHub asset URLs retain their existing behavior.

No historical releases or assets are removed. Versioned nightly asset names
continue to accumulate; retention and historical cleanup require a separate
decision. The R2 channel comparator repair remains in PR #3452; this change only
hardens the independent rolling GitHub newest-wins guard.

`python3 scripts/release/test_release_publication.py` executes the workflow shell
against local GitHub/R2 fakes, including stale reruns, failed reads, complete
payloads, interrupted bootstrap, and superseded beta archival. It performs no
network requests or real publication.
