# Security Policy

## Reporting a Vulnerability

Do not report security vulnerabilities through public Issues, Discussions, or pull requests.

Send the report to [security@primeintellect.ai](mailto:security@primeintellect.ai). For encrypted communication and the current company-wide disclosure policy, see [primeintellect.ai/security](https://www.primeintellect.ai/security).

Include the following when possible:

- The affected version or commit
- The affected component and environment
- Reproduction steps or a minimal proof of concept
- The expected and observed impact
- Any known mitigations

Do not include real API keys, tokens, personal data, or credentials in the report. Use redacted or disposable test values.

## Verifying a Release

Release archives are published with a `SHA256SUMS` inventory and a keyless cosign signature over that
inventory (`SHA256SUMS.sigstore.json`), signed by this repository's release workflow. `prime-agent
update` verifies that signature before installing anything and fails closed if it does not match.

To check a download yourself, and for the full release trust model, see
[Release Security](packages/coding-agent/docs/release-security.md).

## What to Expect

Maintainers will assess the report, determine its scope, and coordinate remediation and disclosure when appropriate. Please allow time for investigation before publishing details that could put users at risk.

Security fixes are generally prepared against the default branch and released on a schedule chosen by the maintainers. We do not guarantee fixes for older versions.

For ordinary bugs, feature requests, and support questions, use [GitHub Discussions](https://github.com/PrimeIntellect-ai/prime-agent/discussions).
