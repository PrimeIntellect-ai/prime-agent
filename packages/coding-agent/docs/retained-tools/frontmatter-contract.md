# Retained Frontmatter Contract (`metadata.prime-agent.retained`)

Canonical reference for the additive frontmatter that marks an ordinary skill as a retained tool. Shared by phases B (loader, snapshots), C (reliability gates), D (`always_in_prompt`), and E/F (provenance writers) — keep it in one place so it cannot drift. Phase docs link here instead of re-specifying fields.

**Issue:** [#5](https://github.com/badvision/prime-agent/issues/5) (SARK T05). **Consumers:** the skill loader (`src/core/skills.ts`), the index upsert (`src/core/retained-tools/rebuild.ts`), and every phase that reads or writes retained state.

## Canonical shape

`smoke` and `always_in_prompt` live **outside** `retained`, as siblings under `metadata.prime-agent`. The `retained` block holds the tool-lifecycle state (version + status) plus provenance.

```yaml
---
name: deploy-staging-canary
description: Runs the staging canary deploy sequence (build, tag, rollout, verify).
metadata:
  prime-agent:
    retained:
      version: 1
      status: active            # active | flagged | disabled | archived
      provenance:
        created_by: refine      # user | refine | auto-proposal
        source_sessions:
          - 01a0205d-0b6f-74f8-94f4-ad4cde6226c8
        first_seen: 2026-08-20T18:00:00Z
        summary: Retained from 2 sessions where the canary sequence ran end-to-end.
    smoke:                      # optional; list of kernel snippet strings (Python skills: required at T08)
      - "import deploy_canary; assert deploy_canary.ping()"
    always_in_prompt: true      # optional; consumed by phase D (T16), ignored by the T05 loader
---
# body: the procedure / call contract
```

## Field table

| YAML path | Type | Required | Default | Validation behavior | Consumed by |
|---|---|---|---|---|---|
| `metadata.prime-agent.retained` | map | — | absent = not a retained tool | absent/null/non-map → skill is a plain skill (no `retained` on the loaded `Skill`; index entry gets defaults) | T05 loader + T02 index upsert |
| `retained.version` | integer ≥ 1 | when `retained` present | `1` | non-integer / ≤ 0 / wrong type → default `1` (no error, no diagnostic) | T02 index upsert; T06 snapshots; T09 rollback |
| `retained.status` | enum `active` \| `flagged` \| `disabled` \| `archived` | when `retained` present | `active` | unknown value → default `active` (silent, T02 behavior) | T05 prompt filter; T10–T13 gates |
| `retained.provenance.created_by` | enum `user` \| `refine` \| `auto-proposal` | recommended | — | tolerated, not validated by the loader (no T05 consumer); writers: T07 (`user`), phase E (`refine`), phase F (`auto-proposal`) | provenance audit |
| `retained.provenance.source_sessions` | list of session-id strings (resolvable under `~/.prime/agent/session-artifacts/<id>/`) | recommended | — | same: tolerated, documented for writers | provenance audit |
| `retained.provenance.first_seen` | ISO-8601 timestamp string | recommended | — | same | provenance audit |
| `retained.provenance.summary` | string (1–2 sentences) | recommended | — | same | provenance audit |
| `metadata.prime-agent.smoke` | list of strings (kernel snippets run in a scratch venv at retention time) | optional (required for Python retained tools — enforced at T08, not T05) | absent | tolerated, ignored by the T05 loader | T08 materializer |
| `metadata.prime-agent.always_in_prompt` | boolean | optional | `false` | wrong type → treated as absent; ignored by the T05 loader | T16 retrieval (phase D) |

## Rules

1. **Additive only.** The block sits alongside existing `name`/`description`/`disable-model-invocation`. A skill with no `metadata.prime-agent` is a plain skill; nothing about loading, prompting, or indexing changes for it.
2. **Loader leniency is a feature.** Unknown keys at any level (including extra keys under `retained`) are parsed and ignored — never rejected, never warned on. This matches `SkillFrontmatter`'s catch-all index signature and the T02 silent defaults, and is what makes the additive contract migration-safe.
3. **Defaults, not errors.** Any malformed retained value degrades to the column default (bad `version` → `1`, bad `status` → `active`); the skill still loads and still gets an index entry.
4. **Only `version` and `status` are persisted to the index.** The index schema (v1) is unchanged by this contract; provenance, smoke, and `always_in_prompt` are frontmatter-only state, read from the canonical skill dir when a phase needs them.
5. **Status semantics at T05 scope.** `active`/`flagged` → injected in `<available_skills>` exactly as today; `disabled`/`archived` → absent from the prompt block but still loaded, still indexed, and still explicitly invocable via `/skill:<name>`. `flagged` is *not* excluded: it is a phase-C warning state, and only C's gates ever change it.
6. **By-id-only referencing convention.** Harness `skill` entries reference a retained tool by its id only — the skill name, which is the index entry key and the `/skill:<name>` target. The referencing spec layer (the harness entry) carries no copy of the tool's description, body, or frontmatter. The canonical skill directory is the single source of content: canonical skill dir → derived per-scope `tools/index.json` → reference-by-id harness entry (ADR-1 layering).
7. **Byte-identical invariant.** With no retained frontmatter present anywhere, the rendered default-catalog prompt block is byte-identical to today's `formatSkillsForPrompt` output. This is locked by the golden fixture `packages/coding-agent/test/fixtures/retained-tools/available-skills-default-catalog.txt` (asserted in `test/suite/regressions/5-retained-frontmatter.test.ts`).

## Relationships

- Phase B context view (with the B-specific narrative): [phase-b-retention.md](phase-b-retention.md)
- Design hub and invariants: [../retained-tools.md](../retained-tools.md)
- Implementation: `parseRetainedMeta` in `src/core/retained-tools/meta.ts` (single canonical validation path shared by the T02 upsert and the T05 loader attach).
