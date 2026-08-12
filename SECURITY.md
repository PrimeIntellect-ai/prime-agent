# Security Policy

## Reporting a Vulnerability

Security vulnerabilities can be reported privately via GitHub's [Private Vulnerability Reporting](https://github.com/PrimeIntellect-ai/prime-agent/security/advisories/new) or by emailing **security@primeintellect.ai**.

Please include:
- A clear description of the vulnerability
- Steps to reproduce
- Affected versions
- Any potential mitigations you've identified

We aim to acknowledge reports within 48 hours and provide an initial assessment within 5 business days.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Older releases | No |

## Security Considerations for Prime Agent Users

Prime Agent executes model-generated code and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; they are **not** a security sandbox.

- Review changes before committing them
- Use trusted repositories, instructions, skills, and extensions only
- Run untrusted code or instructions in an external sandbox or restricted environment
- Be especially cautious with autonomous mode and long-running agent sessions
- Audit agent-accessible credentials and environment variables

## Responsible Disclosure

We follow coordinated disclosure practices. Please do not publicly disclose vulnerabilities until we have had a reasonable opportunity to address them.
