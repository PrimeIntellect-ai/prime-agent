# Phase C — Reliability Gates (issues [#10]–[#13](https://github.com/badvision/prime-agent/issues/10), size S)

Read this doc when working on #10–#13. SARK REQ-703/704 semantics on prime-agent's honest signals: the index recomputes `flagged`/`disabled`/`archived` from explicit counters, the prompt reflects status, and manual plus refine-driven transitions exist. Depends on phase A (counters) and phase B (status contract); T10–T12 need only A+B’s frontmatter and can run in parallel with phase D.

## Gate semantics

Recomputed on load and on counter update (SARK thresholds, applied to **explicit** signals only — see phase A's honest-signal rule):

| Status | Condition | Effects |
|---|---|---|
| `flagged` | `used ≥ 10` AND explicit success rate `< 90%` (when `explicit_ok+explicit_fail ≥ 10`) | Prompt injection keeps the skill but appends a one-line reliability warning to its description line; a harness memory note is created explaining the flag (so the model can route around it deliberately) |
| `disabled` | `used ≥ 10` AND explicit success rate `< 50%` (Python skills may additionally use kernel-error rate) | Excluded from prompt injection (and from the semantic index in phase D), still reachable by explicit `/skill:<name>` for repair; a harness memory note records the reason. **Never auto-re-enables** (mirrors SARK REQ-704 "until manual review") — re-enable via `/tools re-enable <name>` or a refine edit |
| `archived` | User or refine action (not automatic) | Excluded from the index and prompt; files retained on disk. (Mitigates context bloat — risk 1 in [risks-and-decisions.md](risks-and-decisions.md).) |

Each automatic transition writes a harness memory note explaining the reason.

## Manual status commands (#11)

`/tools re-enable <name> | disable <name> | archive <name>` on the existing `/tools` command. Re-enable is the only path back from `disabled` (manual review).

## Refine sees the usage table (#12)

A compact per-tool usage/status table (name, status, used, explicit ok/fail, last_used) is appended to the refine LLM-pass context — mirroring SARK's adaptive-prompt embedding of tool stats (`AdaptiveSystemPromptTemplate`) — so refine can see candidates to prune, flag, or disable.

## Refine edits for status transitions (#13)

The refine edit contract (`validateEdit`-style, fail closed) accepts status-change edits on retained skills (`re-enable`, `disable`, `archive`), applied through the standard apply path: frontmatter updated, index upserted, refinement event recorded, snapshot taken. This is the one place phase C needs phase B.

## Integration points

- `packages/coding-agent/src/core/skills.ts` — load: upsert index entries from disk, skip `disabled`/`archived` from prompt injection
- `packages/coding-agent/src/core/agent-session.ts` — tool-result and skill-load events → index counters; refine context includes the usage table
- `packages/coding-agent/src/core/slash-commands.ts` — `/tools` status subcommands
- `packages/coding-agent/src/core/system-prompt.ts` — warning suffix on flagged descriptions
- `packages/coding-agent/src/core/refinement/refinement.ts` — usage table in the LLM-pass context; status-change edit validation/apply
- Index writes stay atomic (phase A's store).

## Tasks

| Task | Issue | Brief | Done when | Depends |
|---|---|---|---|---|
| T10 Gate engine: flag/disable transitions | [#10](https://github.com/badvision/prime-agent/issues/10) | Recompute status on load and on counter update per the table above; memory notes on transition | Acceptance criterion #3 (below) on synthetic counter states | T03, T05 |
| T11 `/tools re-enable \| disable \| archive` | [#11](https://github.com/badvision/prime-agent/issues/11) | Manual status subcommands; re-enable is the only path back from disabled | `/tools re-enable <name>` flips a disabled tool to `active` and it reappears in a fresh prompt; `/tools archive <name>` removes it from the index and prompt while the skill directory remains on disk | T04, T10 |
| T12 Usage table in the refine context | [#12](https://github.com/badvision/prime-agent/issues/12) | Compact per-tool usage/status table appended to the refine LLM-pass context | A refine pass's input (captured in the LLM-pass debug log) contains the table and lists a seeded `flagged` tool with its counters | T03, T10 |
| T13 Refine edits for status transitions | [#13](https://github.com/badvision/prime-agent/issues/13) | Extend the refine edit contract (fail closed) for status changes on retained skills, applied through the standard path | A refine proposal with a status-change edit validates and applies (frontmatter + index both updated); rejected when it targets a non-retained skill or an invalid status | T05, T10, T12 |

## Acceptance criterion (design #3 → T10/#10)

Given a skill with 10+ uses and 90–100% explicit success, when the index recomputes gates, then status stays `active`; with <90% it becomes `flagged` and its prompt line carries the warning suffix; with <50% it becomes `disabled` and is excluded from prompt injection but still invocable via `/skill:<name>`.

## Watch item (design risk 4)

If explicit signals stay rare in practice, flag/disable will rarely fire and the index's value degrades to usage recency — acceptable, but should be reviewed after this phase lands. If real use shows <5 explicit signals per month, drop auto-disable (keep flag-only) and re-baseline thresholds on SARK's data (see [risks-and-decisions.md](risks-and-decisions.md) contingency options).
