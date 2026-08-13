# Contributing to Prime Agent

Prime Agent is developed in public, and we welcome bug reports, feature ideas, questions, and other feedback. To keep the project maintainable, public contributions begin in [GitHub Discussions](https://github.com/PrimeIntellect-ai/prime-agent/discussions).

We do not review unsolicited pull requests or use public Issues as the initial intake queue.

## Start with a Discussion

Choose the category that best matches what you want to share:

- [Bug report](https://github.com/PrimeIntellect-ai/prime-agent/discussions/categories/general)
- [Feature idea](https://github.com/PrimeIntellect-ai/prime-agent/discussions/categories/ideas)
- [Question](https://github.com/PrimeIntellect-ai/prime-agent/discussions/categories/q-a)

Search existing Discussions before creating a new one. Include enough detail for someone else to understand and reproduce the problem, but do not share API keys, tokens, private prompts, or other sensitive information.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of posting publicly.

## Issues are the Work Queue

GitHub Issues track work that maintainers have accepted and intend to investigate or implement. A maintainer may create an Issue from a Discussion when the scope is clear and the work fits the roadmap.

An existing Issue does not automatically mean that an external pull request is wanted. Wait for a maintainer to invite implementation before starting substantial work.

Issues opened by unapproved contributors are automatically closed and redirected to Discussions.

## Pull Requests and Trusted Contributors

Prime Agent runs on user machines and can execute code with the user's permissions. We therefore limit pull requests to maintainers and trusted contributors who have been explicitly vouched for.

Maintainers may vouch for someone after they have consistently demonstrated a useful understanding of the project through Discussions, issue investigation, testing, documentation, or other collaboration. There is no separate application process and no guarantee that participation will result in approval.

Pull requests from unvouched contributors are automatically closed. If you are interested in contributing code, begin with a Discussion and work with the maintainers on the problem first.

Trusted status may be removed if it is no longer appropriate. Approved external contributors may also be asked to sign a contributor license agreement before a contribution can be merged.

## Preparing an Approved Pull Request

If a maintainer has invited a pull request:

1. Keep the change focused on the accepted Issue or Discussion.
2. Follow the repository's development rules and existing conventions.
3. Add or update tests for behavioral changes.
4. Run the relevant checks locally and describe the validation in the pull request.
5. Avoid unrelated refactors or dependency changes.

Development setup and commands are documented in the [development guide](packages/coding-agent/docs/development.md).

Maintainers may close a pull request that changes scope, cannot be validated safely, or no longer fits the project roadmap.
