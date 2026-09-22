# Release-signature fixtures

These are REAL, unmodified Sigstore artifacts, used so the tests exercise the actual cryptography
(Fulcio chain, certificate-transparency SCT, Rekor inclusion proof and inclusion promise) against
the embedded Sigstore trusted root, with no network access.

| file | what it is |
| --- | --- |
| `SHA256SUMS` | `checksums.txt` from the `charmbracelet/crush` GitHub release (a `sha256sum` document, the same shape our release publishes). |
| `SHA256SUMS.sigstore.json` | The cosign keyless bundle published beside it, byte-for-byte. |
| `SHA256SUMS.no-tsa.sigstore.json` | The same bundle with `timestampVerificationData` removed. This is the shape `cosign sign-blob --yes --bundle` emits without `--timestamp-server-url`, i.e. what our own release lane will produce. Nothing else is changed. |

Why a foreign project's bundle: a valid signature for `PrimeIntellect-ai/prime-agent` can only be
produced by the real release workflow, which cannot run from a test. Using a genuine third-party
bundle gives us both halves of the contract:

* the happy path, by pinning the verifier to the fixture's own identity through the in-process
  `identity` test seam - this proves the whole chain verifies offline;
* the negative path, by pinning the verifier to the production identity - this proves a
  cryptographically perfect signature from the wrong repository/workflow/ref is still refused.

The fixture identity is
`https://github.com/charmbracelet/meta/.github/workflows/goreleaser.yml@refs/heads/main`,
source repository `https://github.com/charmbracelet/crush`, issuer
`https://token.actions.githubusercontent.com`, runner environment `github-hosted`.

These fixtures never expire: Sigstore verification uses the transparency-log timestamp, not the
wall clock, so the short-lived Fulcio certificate stays verifiable forever.
