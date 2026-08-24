# Upstream provenance

- Source: https://github.com/obra/superpowers
- Version: 6.2.0 (exact version)
- Commit: `9ba3bcd10b9e92be0b299d8721f1393b92e911a0` (exact commit)
- Import scope: upstream `skills/**` and `LICENSE`; plugin manifests, hooks, docs, release notes, package metadata, and unrelated assets are excluded.
- License: MIT; see [LICENSE](LICENSE).
- Machine-readable source record: [SOURCE.json](SOURCE.json); package-local attribution: [THIRD_PARTY_NOTICE.md](THIRD_PARTY_NOTICE.md).
- Fork status: this is an intentional Prime Agent fork. Every local modification is explicit in the allowlist below; all other imported upstream bytes remain exact.

## Local fork policy

Routed worker, planner, reviewer, debugger, verifier, and author contracts are
methodology-only. The host scheduler assigns the named Luna capacity; non-host
roles have `write=none`, `stage=none`, `commit=none`, and `push=none`, and may
not approve, merge, or declare completion. Review and worktree inputs are
caller-supplied canonical full immutable SHAs; local modifications must be
explicit and the upstream license must remain present. Unit tests are permitted
only as temporary debugging probes; durable acceptance is a public intent test,
and counts, coverage, and mock-only evidence never promote work.

## Modified-file allowlist

- `skills/brainstorming/SKILL.md`
- `skills/brainstorming/spec-document-reviewer-prompt.md`
- `skills/brainstorming/visual-companion.md`
- `skills/dispatching-parallel-agents/SKILL.md`
- `skills/executing-plans/SKILL.md`
- `skills/finishing-a-development-branch/SKILL.md`
- `skills/receiving-code-review/SKILL.md`
- `skills/requesting-code-review/SKILL.md`
- `skills/requesting-code-review/code-reviewer.md`
- `skills/subagent-driven-development/SKILL.md`
- `skills/subagent-driven-development/implementer-prompt.md`
- `skills/subagent-driven-development/re-review-prompt.md`
- `skills/subagent-driven-development/scripts/review-package`
- `skills/subagent-driven-development/task-reviewer-prompt.md`
- `skills/systematic-debugging/CREATION-LOG.md`
- `skills/systematic-debugging/condition-based-waiting-example.ts`
- `skills/systematic-debugging/condition-based-waiting.md`
- `skills/systematic-debugging/SKILL.md`
- `skills/systematic-debugging/defense-in-depth.md`
- `skills/systematic-debugging/find-polluter.sh`
- `skills/systematic-debugging/root-cause-tracing.md`
- `skills/test-driven-development/SKILL.md`
- `skills/test-driven-development/writing-good-tests.md`
- `skills/using-git-worktrees/SKILL.md`
- `skills/using-superpowers/SKILL.md`
- `skills/using-superpowers/references/antigravity-tools.md`
- `skills/using-superpowers/references/codex-tools.md`
- `skills/using-superpowers/references/gemini-tools.md`
- `skills/using-superpowers/references/pi-tools.md`
- `skills/verification-before-completion/SKILL.md`
- `skills/writing-plans/SKILL.md`
- `skills/writing-plans/plan-document-reviewer-prompt.md`
- `skills/writing-skills/SKILL.md`
- `skills/writing-skills/anthropic-best-practices.md`
- `skills/writing-skills/examples/CLAUDE_MD_TESTING.md`
- `skills/writing-skills/graphviz-conventions.dot`
- `skills/writing-skills/testing-skills-with-subagents.md`

Local modifications must be explicit, the allowlist must stay exact, and the upstream MIT license text is retained; the license must be retained for every forked release.

The earlier design-spec source reference `b6b58974aa8c731d7c160975959a0e62777975c6`
is superseded for this vendored package by the pinned `6.2.0` source commit
`9ba3bcd10b9e92be0b299d8721f1393b92e911a0`. `SOURCE.json` and
`THIRD_PARTY_NOTICE.md` are authoritative for this snapshot.

## Reference audit

The bundled reference audit supports Markdown links of the form `[label](relative-path)`, inline scripts/references paths (`./`, `../`, `scripts/`, `references/`, and `skills/`), and sibling filenames with known bundled-resource extensions. It applies root-escape rejection to any local reference that leaves the bundled skill root. External URLs, anchors, and illustrative placeholder paths are intentionally excluded from local traversal; unsupported syntax must be added explicitly before being relied on. Bare filenames that are merely prose examples are not treated as references.
