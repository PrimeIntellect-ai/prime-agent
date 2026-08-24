# Prime Agent fork patches

Upstream baseline: `9ba3bcd10b9e92be0b299d8721f1393b92e911a0` (Superpowers 6.2.0).

The fork keeps every non-allowlisted upstream byte exact. The semantic changes are:

- `skills/brainstorming/SKILL.md`: keeps brainstorming read-only by default, skips standalone artifacts for small changes, and keeps design prose free of implementation code blocks.
- `skills/brainstorming/spec-document-reviewer-prompt.md`: assigns read-only spec review to host-assigned Luna capacity without granting approval or write authority.
- `skills/brainstorming/visual-companion.md`: routes screen/state and repository-metadata writes through explicit host grants.
- `skills/dispatching-parallel-agents/SKILL.md`: makes parallel dispatch methodology-only; the host assigns named Luna capacity and owns write, stage, commit, push, approval, merge, and completion authority.
- `skills/executing-plans/SKILL.md`: routes each task through public intent RED/GREEN, durable regressions, real-boundary evidence, host-pinned worktrees, and independent review without granting write, stage, commit, or push authority.
- `skills/finishing-a-development-branch/SKILL.md`: turns branch finishing into an evidence and integration recommendation for immutable candidate/integration SHAs; the host retains write, stage, commit, push, mutation, and completion authority.
- `skills/receiving-code-review/SKILL.md`: keeps review-driven fixes at the public intent boundary; permits unit probes only temporarily for debugging and treats mocks, counts, and coverage as supplemental diagnostics under named-Luna host authority with no write, stage, commit, or push access.
- `skills/requesting-code-review/SKILL.md`: requires canonical caller-supplied full base, candidate, and integration SHAs, validates that integration is an ancestor of base and both reach candidate, binds the receipt, and uses host-assigned Luna capacity without write, stage, commit, or push authority.
- `skills/requesting-code-review/code-reviewer.md`: makes review read-only, rejects moving refs and sibling integration histories, verifies exact ancestry, and removes worktree creation and coverage/count completion claims; unit probes are temporary debugging aids only.
- `skills/subagent-driven-development/SKILL.md`: uses role-based dispatch with host-assigned Luna capacity and exact review-package SHA inputs while keeping writes, approval, merge, and completion outside the skill.
- `skills/subagent-driven-development/implementer-prompt.md`: requires public intent acceptance, observed RED, durable adversarial regressions, real-boundary evidence, host-assigned Luna capacity, and temporary debugging-only unit probes.
- `skills/subagent-driven-development/re-review-prompt.md`: binds re-review evidence to public acceptance, immutable candidate/integration inputs, host-assigned Luna read-only capacity, and temporary debugging-only unit probes.
- `skills/subagent-driven-development/scripts/review-package`: requires canonical full base/candidate/integration SHAs, verifies integration is an ancestor of base and both base and integration reach candidate, and writes an exact-SHA review receipt.
- `skills/subagent-driven-development/task-reviewer-prompt.md`: makes public intent evidence and anti-cheating review mandatory; unit probes are temporary debugging aids, unit or mock-only checks cannot promote work, and review capacity is host-assigned Luna.
- `skills/systematic-debugging/CREATION-LOG.md`: records public-boundary intent regressions and real evidence; unit probes are temporary debugging aids, and mocks, counts, and coverage cannot promote completion.
- `skills/systematic-debugging/condition-based-waiting-example.ts`: labels historical timing-test metrics as diagnostics and keeps public-boundary intent evidence authoritative.
- `skills/systematic-debugging/condition-based-waiting.md`: keeps condition-waiting helpers as temporary debugging probes and rejects count, pass-rate, coverage, or mock-only completion evidence.
- `skills/systematic-debugging/SKILL.md`: limits unit probes to temporary diagnosis and requires public-boundary regressions plus real durability or authority evidence.
- `skills/systematic-debugging/defense-in-depth.md`: requires public-boundary evidence and rejects mock, count, or coverage-only completion claims.
- `skills/systematic-debugging/find-polluter.sh`: delegates the acceptance runner to a host-supplied command and reports pollution without test-count completion claims.
- `skills/systematic-debugging/root-cause-tracing.md`: preserves root-cause failures as durable public intent regressions and removes raw runner/count evidence.
- `skills/test-driven-development/SKILL.md`: centers TDD on user intent, forbidden outcomes, public-boundary RED, adversarial regressions, real evidence, anti-cheating, and independent review; unit tests are permitted only as temporary debugging probes.
- `skills/test-driven-development/writing-good-tests.md`: makes public-boundary intent tests durable and permits unit probes only temporarily for debugging while treating mocks, counts, and coverage as supplemental diagnostics.
- `skills/using-git-worktrees/SKILL.md`: pins substantial work to a caller-supplied canonical full integration SHA, executes an exact-HEAD guard for existing/native/fallback workspaces, keeps small edits coordinator-owned, forbids inferred merge bases and in-place fallbacks, and requires an explicit host write grant.
- `skills/using-superpowers/SKILL.md`: routes implementation workflows through public-boundary TDD and review gates while leaving capacity and authority to the host.
- `skills/using-superpowers/references/antigravity-tools.md`: makes host ownership of writes, approvals, merges, completion, and Luna capacity explicit.
- `skills/using-superpowers/references/codex-tools.md`: requires the pinned runtime for host-assigned Luna capacity and removes agent-side stage/commit/merge authority.
- `skills/using-superpowers/references/gemini-tools.md`: routes tool mutation and Luna capacity assignment through the host instead of generic agent labels.
- `skills/using-superpowers/references/pi-tools.md`: routes subagent capacity and all mutation authority through the host.
- `skills/verification-before-completion/SKILL.md`: requires fresh public intent evidence and adversarial verification without granting completion authority or using counts as evidence.
- `skills/writing-plans/SKILL.md`: emits concise task graphs, constraints, and acceptance scenarios without implementation pseudo-code or unit-only GREEN claims.
- `skills/writing-plans/plan-document-reviewer-prompt.md`: assigns read-only plan review to host-assigned Luna capacity without granting approval or write authority.
- `skills/writing-skills/SKILL.md`: delegates deployment mutation and integration decisions to the host, and makes public-process intent scenarios authoritative over diagnostic counts or coverage.
- `skills/writing-skills/anthropic-best-practices.md`: replaces non-Luna model-tier guidance with host-assigned Luna capacity and stable public-boundary evaluation.
- `skills/writing-skills/examples/CLAUDE_MD_TESTING.md`: keeps integration choices with the host rather than directing agent commits.
- `skills/writing-skills/graphviz-conventions.dot`: replaces raw build/commit actions with host acceptance and integration placeholders.
- `skills/writing-skills/testing-skills-with-subagents.md`: makes skill pressure checks scenario-level behavioral fixtures and permits unit probes only temporarily for debugging; mock, count, and coverage output remains supplemental.

Local modifications must remain explicit and must retain the upstream MIT license.

## Provenance reconciliation

`SOURCE.json` and `THIRD_PARTY_NOTICE.md` bind this package to upstream
Superpowers 6.2.0 at `9ba3bcd10b9e92be0b299d8721f1393b92e911a0`, superseding the
stale design-spec reference `b6b58974aa8c731d7c160975959a0e62777975c6`. The
exact upstream `LICENSE` remains authoritative and is retained unchanged.
