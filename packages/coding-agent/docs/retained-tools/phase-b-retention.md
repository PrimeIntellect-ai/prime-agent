# Phase B — Explicit Retention & Versioning (issues [#5]–[#9](https://github.com/badvision/prime-agent/issues/5), size M)

Read this doc when working on #5–#9. The user-visible core of the effort: **a solved task becomes a retained tool with a human in the loop.** Depends on phase A (#1–#4).

## Data model: the retained frontmatter contract (#5)

A retained tool is an ordinary skill directory plus additive frontmatter (unknown frontmatter is already tolerated by the loader, `packages/coding-agent/docs/skills.md`). The canonical field table, validation behavior, and rules live in [frontmatter-contract.md](frontmatter-contract.md); the sample below is the phase-B context view:

```yaml
# .prime/agent/skills/deploy-staging-canary/SKILL.md  (or ~/.prime/agent/skills/ for global)
---
name: deploy-staging-canary
description: Runs the staging canary deploy sequence (build, tag, rollout, verify). Use when deploying to staging after a green CI run.
metadata:
  prime-agent:
    retained:
      version: 1
      status: active              # active | flagged | disabled | archived
      provenance:
        created_by: refine        # user | refine | auto-proposal
        source_sessions: [01a0205d-0b6f-74f8-94f4-ad4cde6226c8]
        first_seen: 2026-08-20T18:00:00Z
        summary: "Retained from 2 sessions where the staging canary sequence was executed end-to-end"
    smoke:                        # optional: kernel snippets executed in a scratch venv at retention time (Python skills: required)
      - "import deploy_canary; assert deploy_canary.ping()"
---
# body: the procedure / call contract
```

Loader support (T05): upsert `version`/`status` into the index at load; inject `active` tools as today; exclude `disabled`/`archived` from the prompt while keeping them explicitly invocable via `/skill:<name>`. **Skills without the frontmatter behave byte-identically to today** — loader leniency is a feature, not a bug to fix. The contract doc also records the convention that harness `skill` entries reference retained tools by `id` only (the referencing spec layer, no content duplication). Python-backed retained tools additionally follow the existing Python-skill contract (`packages/coding-agent/skills/skill-creator/SKILL.md` → `references/python-skills.md`; venv install mechanics in `packages/coding-agent/src/core/kernel/bootstrap.ts`).

## Creation path — who decides to retain

Three entry points, one materializer:

| Entry | Decider | Trust level | Phase |
|---|---|---|---|
| Explicit: `/retain "<what>"` (new slash command) or natural-language "make a skill from this" | User, this turn | Highest — markdown and Python both allowed (Python still requires smoke pass) | B (this doc) |
| Refine-driven: refine LLM pass emits a materialize edit | LLM trajectory review, applied at turn end, user-visible result message | Medium — markdown auto-apply allowed; **Python materialize edits always require explicit confirmation** | E ([phase-e-refine-retention.md](phase-e-refine-retention.md)) |
| Auto-proposal: auto-refine gate retention signal | Heuristic gate + LLM review | Lowest — proposal only; never auto-applies executable code | F ([phase-f-autodetection.md](phase-f-autodetection.md)) |

**The materializer** (shared by all three; #7 for the explicit path) takes a procedure description + trajectory and:

1. Writes the skill directory via the existing skill-creator contract, with the retained frontmatter (provenance `created_by`, source session ids read from the session-artifact dir, `first_seen`, summary).
2. Snapshots any pre-existing version (T06, below).
3. For Python skills: installs into a **scratch** kernel venv and runs the `smoke` snippets **before** the tool is marked `active`. Failure → `status: disabled` with the error recorded in the refinement event (never `active` on failed smoke).
4. Upserts the index entry (phase A).
5. Records a normal refinement event so the standard rollback works.

This keeps refine's existing safety rails (typed edits, baseline conflict rejection, rollback) fully intact: retention is a new *effect* of a validated edit, not a new loop.

**Collision handling:** the materializer checks for same-named skills across scopes and warns/blocks on collision (the loader is first-found-wins with precedence, `packages/coding-agent/docs/skills.md`).

## Snapshot store: `skills-versions` + rotation + restore (#6)

Per-tool snapshots at `~/.prime/agent/skills-versions/<scope>/<name>/<version>.json` — a JSON document with the prior SKILL.md content, the frontmatter, and (Python skills) the package file list + content hashes.

- Snapshots are taken **lazily on next load** when `description_hash` changed since the last snapshot (the chosen phase-B approach; a pre-write hook is an optional later enhancement, not a task here).
- Rotate to the last 10 versions per tool; provide a `restore(version)` primitive.
- This copies two mechanisms already trusted: harness-entry `version` (`refinement.ts`) and SARK's `FileBasedToolRepository` backup rotation (60-min interval, keep 10).
- Non-retained skills are not snapshotted (scope kept tight; skill dirs are typically user-versioned in git already).

## Python retained tools + scratch-venv smoke (#8)

Extend the materializer to Python-backed retained tools: build the package per the skill-creator Python contract, install it into a scratch kernel venv, run the `smoke` snippets. Pass → `status: active`; failure → `status: disabled` with the error recorded (never `active` on failed smoke). Rollback of a Python tool removes the scratch-installed package before restore.

> **Predicted growth (design prediction):** this is the piece most likely to grow — the Python skill-creator contract (venv install, import naming) has more moving parts than the markdown path, and "smoke in scratch venv" will hit environment quirks. If it grows, it splits; it does not swallow markdown-path fixes.

## `/tools rollback <name>` + refine rollback integration (#9)

Rollback subcommand: restore the prior snapshot's content, decrement the index `version`, record the event. A refine materialize edit (phase E) reuses the standard refine rollback path: restore last snapshot + remove the index entry.

## Retrieval pipeline (no separate path)

Retained tools are ordinary skills; they enter retrieval exactly like any skill (full-injection today, top-k semantic once phase D's budget threshold is passed). No separate retrieval path exists.

## Integration points

- `packages/coding-agent/src/core/refinement/refinement.ts` — edit validation + materializer (phase E extends this)
- `packages/coding-agent/src/core/agent-session.ts` — apply path, result messaging ("Refined continual harness state: N edits applied")
- `packages/coding-agent/src/core/skills.ts` — read `metadata.prime-agent` at load; honor `status` for prompt injection
- `packages/coding-agent/src/core/slash-commands.ts` — new `/retain`, `/tools` commands
- `packages/coding-agent/skills/skill-creator/SKILL.md` — document the frontmatter contract so human-authored skills get it too
- `prime-agent-runtime/src/rlm/harness.py` — **no change** (kernel keeps using `refine.run(...)` and `/retain`; no new kernel API in this phase)

## Tasks

| Task | Issue | Brief | Done when | Depends |
|---|---|---|---|---|
| T05 Frontmatter contract + loader support | [#5](https://github.com/badvision/prime-agent/issues/5) | Specify the additive frontmatter; teach the loader (index upsert, `active` injected, `disabled`/`archived` excluded from prompt but invocable) | Given a skill dir with the frontmatter, load populates the index entry; a `disabled` skill is absent from `<available_skills>` yet invocable; the default-catalog prompt is byte-identical to today's output | T02 |
| T06 Snapshot store + rotation + restore | [#6](https://github.com/badvision/prime-agent/issues/6) | `skills-versions` snapshots, lazy snapshotting on `description_hash` change, keep-10 rotation, `restore(version)` | Restore round-trip (mutate → rollback → content hash equals snapshot) and rotation (11 versions → exactly the latest 10 remain) pass | T05 |
| T07 `/retain "<what>"` — markdown path | [#7](https://github.com/badvision/prime-agent/issues/7) | Explicit retention command: materializer writes the skill dir, snapshots, collision check, index upsert, refinement event. `ASSUMPTION` (open Q1): project retained tools default to `.prime/agent/skills/` (git-shareable) | Acceptance criterion #1 (below) | T05, T06 |
| T08 Python retained tools + scratch-venv smoke | [#8](https://github.com/badvision/prime-agent/issues/8) | Materializer for Python skills: package build, scratch-venv install, smoke run; disabled-on-failure; rollback removes the installed package | Acceptance criterion #2 (below) | T07 |
| T09 `/tools rollback` + refine rollback integration | [#9](https://github.com/badvision/prime-agent/issues/9) | Rollback subcommand + standard refine rollback path for materialize edits | Acceptance criterion #6 (below) | T04, T06, T08 |

## Acceptance criteria (from the design handoff)

1. **(→ T07/#7)** Given a project session that solved task X, when the user runs `/retain "X procedure"`, then a skill dir exists at `.prime/agent/skills/<name>/` with `metadata.prime-agent.retained` provenance, `status: active`, an index entry, and a version snapshot; a fresh session's prompt includes its description.
2. **(→ T08/#8)** Given a Python retained tool whose `smoke` fails in the scratch venv, when materialization runs, then the tool is `disabled` (not `active`) and the refinement event records the failure.
6. **(→ T09/#9)** Given any retained tool, when `/tools rollback <name>` runs, then the prior snapshot's content is restored and the index version decrements; a rollback of a materialize edit for a never-before-existing tool ends with no index entry.

## Quality gates

- All existing skill validation applies (frontmatter rules, name↔dir match, non-empty description).
- Python retained tools: import + `smoke` must pass in the scratch venv before `active`.
- Provenance must record source session ids (readable from `~/.prime/agent/session-artifacts/<id>/`).
- **End-user verification is part of done:** the proposing session (or a fresh subagent) invokes the retained tool once in a fresh session and reports the result before the work is considered complete (SARK docs-vs-reality countermeasure).

## Migration / compatibility

Purely additive: old skills without `metadata.prime-agent` behave exactly as today (loader leniency); the index is new state; no existing skill files are touched.
