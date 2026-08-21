# Phase A — Tool Index & Usage Tracking (issues [#1]–[#4](https://github.com/badvision/prime-agent/issues/1), size S)

Read this doc when working on #1–#4. Foundation phase: no user-visible behavior change, but everything else (B, C, D, F) reads and writes the index it creates.

## Purpose

The derived registry that everything else reads and writes: one rebuildable JSON index per scope (`~/.prime/agent/tools/index.json` global, `.prime/agent/tools/index.json` project) holding usage counters, status, provenance summary, and (phase D) embeddings.

**Layering decision (ADR-1, recorded in #1):** three layers, one canonical source —

1. **Artifact layer (canonical):** the skill directory on disk; same locations and precedence as today (`packages/coding-agent/docs/skills.md` "Locations"). A retained tool IS a skill; not a new artifact type.
2. **Registry/index layer (derived):** the JSON index per scope. Rebuildable from disk at any time; **usage counters are the only state that lives only in the index**.
3. **Spec layer (reference, not copy):** continual-harness `skill` entries (`harness_state.json`) may reference a retained tool by `id` for routing hints; they never duplicate tool content.

## Data model (index schema v1)

Global example; the project index has the same shape. Written atomically (temp file + rename, the existing `saveHarnessState` pattern in `packages/coding-agent/src/core/refinement/refinement.ts`).

```json
{
  "schema": 1,
  "updated": "2026-08-20T18:00:00Z",
  "skills": {
    "deploy-staging-canary": {
      "scope": "project",
      "path": ".prime/agent/skills/deploy-staging-canary",
      "version": 1,
      "status": "active",
      "usage": {
        "used": 14, "explicit_ok": 12, "explicit_fail": 1,
        "last_used": "2026-08-19T10:22:00Z", "last_status": "ok",
        "recent_failures": [{"at": "2026-08-14T09:00:00Z", "note": "rollout step timed out twice"}]
      },
      "description_hash": "sha256:…",
      "embedding": [ ]
    }
  }
}
```

Note: the `embedding` field and top-level `embedding_model`/`embedding_dim` exist in schema v1 from the start so phase D does not bump the schema.

## Event sources (honest-signal counters)

Deliberately conservative; all derivable from existing capture points:

- `used++` when a session (a) invokes `/skill:<name>`, (b) reads the skill's `SKILL.md` via the kernel (file-read event on a known skill path), or (c) calls a Python skill function (host-request path, `packages/coding-agent/src/core/kernel/index.ts`).
- `explicit_ok` / `explicit_fail` **only from explicit signals**: user statement in a following turn ("that worked" / "no, that broke"), a refine `record_refinement` outcome referencing the tool, or — for Python skills — the call completed / raised in the kernel.
- **Session-level success is NEVER counted as tool success** (honest-signal rule: markdown skills have no binary outcome; see sark-concepts.md §"What not to import").

## Rebuild & merge

- On skill load (startup, `/reload`, post-retention): upsert index entries from disk (scope, path, version, status, `description_hash`), merge counters by `(name, path)`, remove entries for skills that no longer exist.
- A deleted or corrupted index rebuilds from disk; previously recorded counters survive via the merge.

## `/tools list` (read-only, #4)

New `/tools` slash command (registered alongside the existing commands in `packages/coding-agent/src/core/slash-commands.ts`) in read-only form: full catalog with name, scope, path, status, `used`/`explicit_ok`/`explicit_fail`, `last_used`. Project entries shadow same-named global ones, mirroring skill-load precedence.

## Tasks

| Task | Issue | Brief | Done when | Depends |
|---|---|---|---|---|
| T01 Index schema v1 + atomic index store | [#1](https://github.com/badvision/prime-agent/issues/1) | Define the index document above + load/save helpers; atomic writes; record ADR-1 | An `index.test` round-trips empty and populated indexes; a simulated interrupted write leaves the previous file intact; ADR-1 recorded in the repo docs | None |
| T02 Load-time upsert, rebuild, counter merge | [#2](https://github.com/badvision/prime-agent/issues/2) | Upsert from disk at load; merge counters by `(name,path)`; drop stale entries; rebuild on missing/corrupt index | Delete `tools/index.json`, re-run load: all content fields restored, counters survive the merge; entry for a deleted skill is gone | T01 |
| T03 Usage event sources | [#3](https://github.com/badvision/prime-agent/issues/3) | Instrument the four count events above. `ASSUMPTION` (open Q2): counters live per scope in each index with a global view in `/tools` | A scripted synthetic session exercises all four sources, each counter increments exactly once per event; a "successful" session with no explicit signal produces zero `explicit_ok` | T02 |
| T04 `/tools list` (read-only) | [#4](https://github.com/badvision/prime-agent/issues/4) | Read-only `/tools` catalog command with the columns above and project-shadowing-global behavior | In a session with recorded usage, `/tools list` prints the table with those exact columns and shows a project skill shadowing a same-named global skill | T03 |

## Quality gates

- Counters increment only from the four event sources above — nothing else may write them.
- Index rebuild test is part of the phase definition (not optional): delete index → re-run load → content restored, counters preserved.
- No user-visible behavior change in this phase.
