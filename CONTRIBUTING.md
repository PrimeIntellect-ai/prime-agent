# Contributing to Prime Agent

Thanks for your interest in contributing to Prime Agent! Prime Agent is developed in public, and we welcome bug reports, feature requests, questions, and other feedback. To keep the project maintainable, public contributions begin in [GitHub Discussions](https://github.com/PrimeIntellect-ai/prime-agent/discussions).

With the influx of agent-generated contributions, we do not review unsolicited pull requests or use public Issues as the initial intake queue. While we are open to contributions by agents, you are responsible for your code and must understand how it interacts with the entire project.

## Start with a Discussion

Choose the category that best matches what you want to share:

- [General discussion or question](https://github.com/PrimeIntellect-ai/prime-agent/discussions/categories/general)
- [Bug report](https://github.com/PrimeIntellect-ai/prime-agent/discussions/categories/bug-reports)
- [Feature request](https://github.com/PrimeIntellect-ai/prime-agent/discussions/categories/feature-requests)

Search existing Discussions before creating a new one. Include enough detail for someone else to understand and reproduce the problem, but do not share API keys, tokens, private prompts, or other sensitive information.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of posting publicly.

## Issues

GitHub Issues track work that maintainers have accepted and intend to investigate or implement. A maintainer may create an Issue from a Discussion when the scope is clear and the work fits the roadmap. An existing Issue does not automatically mean that an external pull request is wanted. Wait for a maintainer to invite implementation before starting substantial work.

Issues opened by unapproved contributors are automatically closed and redirected to Discussions. To contribute, share interest in Discussions or corresponding issues, and maintainers can invite implementation for requested work.

## Pull Requests and Trusted Contributors

Prime Agent runs on user machines and can execute code with the user's permissions. We therefore limit pull requests to maintainers and trusted contributors who have been explicitly vouched for. Maintainers may vouch for someone after they have consistently demonstrated a useful understanding of the project through Discussions, issue investigation, testing, documentation, or other collaboration. There is no separate application process and no guarantee that participation will result in approval.

Pull requests from unvouched contributors are automatically closed. If you are interested in contributing code, begin with a Discussion and work with the maintainers on the problem first.

## Preparing an Approved Pull Request

If a maintainer has invited a pull request:

1. Keep the change focused on the accepted Issue or Discussion.
2. Follow the repository's development rules and existing conventions.
3. Add or update tests for behavioral changes.
4. Run the relevant checks locally and describe the validation in the pull request.
5. Avoid unrelated refactors or dependency changes.

Development setup and commands are documented in the [development guide](packages/coding-agent/docs/development.md).

## Changelog entries

Do not edit `packages/*/CHANGELOG.md` directly. Instead, add one fragment
file per PR per touched package: `packages/<pkg>/.changes/<slug>.md`, where `<slug>` is a kebab-case name
derived from your branch or ticket (e.g. `eng-1234-fix-resize.md`). The file contains exactly the bullet
line(s) that describe the change, e.g. `- Fixed the frobnicator dropping input on resize.`. The release
script aggregates fragments into the release section and deletes them. PRs that change `packages/<pkg>/src`
without a fragment fail CI; apply the `no-changelog` label to opt out.

Maintainers may close a pull request that changes scope, cannot be validated safely, or no longer fits the project roadmap.
