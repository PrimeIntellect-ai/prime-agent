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

## Behavioral Release Evaluation

The `pre-release` label enables a trusted behavioral evaluation before release. Pull
request source is built only inside an isolated Prime sandbox. GitHub runners treat
candidate packages as opaque bytes and never execute or extract them. A dedicated spend-capped model credential stays behind the trusted ACP interception
boundary and is removed from candidate process environments. Per-rollout request,
turn, token, and time budgets limit the short-lived interception capability. Baseline generations are immutable and integrity-checked before
use. See [`scripts/behavioral-evals/README.md`](scripts/behavioral-evals/README.md) for
the full boundary and maintainer requirements.

## What to Expect

Maintainers will assess the report, determine its scope, and coordinate remediation and disclosure when appropriate. Please allow time for investigation before publishing details that could put users at risk.

Security fixes are generally prepared against the default branch and released on a schedule chosen by the maintainers. We do not guarantee fixes for older versions.

For ordinary bugs, feature requests, and support questions, use [GitHub Discussions](https://github.com/PrimeIntellect-ai/prime-agent/discussions).
