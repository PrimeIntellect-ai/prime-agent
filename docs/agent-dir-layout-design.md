# Agent Directory Layout Design

Status: design, lane `lane/layout-design`. Core (§1-§4): directory tree with
per-path lifetime classes (§2), layout manifest / layout-version schema (§3),
TS backward-compatibility contract (§4, hard ship-blocker). This unit
completes the remaining sections: retention policy (§5), the layered model
registry (§6), the migrator's staged plan with the TS compat matrix (§7), and
open questions (§8).

TS ground truth: `~/prime-agent` (read-only, `prime-agent` 0.9.5 on PATH).
All `packages/...` paths are under that root. Rust paths are under `crates/`.
Live-layout evidence: `~/.prime/agent` on this box (a real, heavily used TS
install). Related docs: `MISSION.md` (config-defined models, mechanism-rethink
license), `ARCHITECTURE.md` (crate ownership), `docs/MODEL-SURFACE.md`
(conversation-log layout), `docs/extensions-runner-design.md` (resource
resolution the layout must serve).

---

## 1. Lifetime classes

Every path in the layout carries exactly one lifetime class. The class defines
what an upgrade, a crash, and a cleanup may do to the path — independent of
the retention policy (§5), the class is already binding:

| class | meaning | upgrade rule | delete-when rule |
|---|---|---|---|
| `config` | User-authored or user-installed intent. Hand-edited files, credentials, installed resources. | Never rewritten behind the user's back; never deleted by the product. | Only on explicit user action. |
| `state` | Product-generated durable data. Losing it loses user-visible value (sessions, ledgers, jobs). | Migrated forward explicitly, gated by `layoutVersion` (§3). | Never as a side effect; only via the retention design (§5). |
| `cache` | Product-generated regenerable data. Losing it costs a rebuild, nothing else. | May be rebuilt or dropped at any time. | Any time; rebuild on demand. |
| `logs` | Diagnostic output. No product behavior depends on it. | Never migrated. | Rotate (single-generation `.old`, 5 MiB cap per TS `appendRotatingLog`, `packages/coding-agent/src/config.ts` L579-614); dir-level caps in §5.4. |

The classes are the vocabulary for every later retention, backup, and support
decision: support asks for `logs`; backup asks for `config` + `state`;
`rm -rf` is only ever safe on `cache` + `logs`.

## 2. Directory tree

### 2.1 Root resolution

- Agent dir: `PRIME_AGENT_CODING_AGENT_DIR` env override (tilde-expanded), else
  `$HOME/.prime/agent` (`packages/coding-agent/src/config.ts` L525-534;
  `CONFIG_DIR_NAME` L497). Rust: `crates/pa-cli/src/config.rs::get_agent_dir`
  (same precedence, tilde expansion).
- Session dir: `PRIME_AGENT_SESSION_DIR` (and legacy
  `PRIME_AGENT_CODING_AGENT_SESSION_DIR`) env override, else cwd-scoped
  settings `sessionDir`, else `<agentDir>/sessions`
  (`config.ts` L621-639; Rust `pa-cli/src/print_runtime.rs` L426). The session
  root may live OUTSIDE the agent dir; everything session-scoped hangs off it
  (`sessions/` and its sibling `session-artifacts/`,
  `session-manager.ts` L320-325).
- Daemon socket: NOT in the agent dir. `$TMPDIR/prime-agent-<uid>/daemon.sock`,
  dir mode 0700, socket mode 0600 (`modes/daemon/daemon-socket.ts` L279-283,
  L10-11). This is the transport trait's per-platform slot; nothing else may
  assume its location.

### 2.2 The tree

Legend: `[C]` config, `[S]` state, `[K]` cache, `[L]` logs.

```
~/.prime/agent/                          # agentDir (§2.1)
├── auth.json                        [C]  # credentials: { "<provider>": { "type": "api_key"|"oauth", ... } }, mode 0600
├── auth.json.lock                   [S]  # advisory lockfile (proper-lockfile style); transient, recreate
├── settings.json                    [C]  # global settings (also cwd-scoped "sessionDir" etc.); hand-edited
├── settings.json.lock               [S]  # transient lock beside the file (settings-manager.ts L304)
├── keybindings.json                 [C]  # custom keybindings (migrations.ts L291)
├── models.json                      [C]  # user-declared model catalog entries; MUST survive catalog refresh
│                                         #   (model-registry.ts L481: registry default path)
├── prime-inference-models-cache.json [K] # network /models cache, next to models.json (model-registry.ts L540)
├── prime-inference-private-models.json [K] # private PI entitlement cache, fingerprint-scoped (model-registry.ts L422; added by this unit — core draft omitted it)
├── cron-jobs.json                   [S]  # user cron jobs (config.ts L611-614)
├── telemetry.json                   [S]  # telemetry counters (telemetry.ts L16)
├── layout.json                      [S]  # NEW, Rust-only: layout manifest + version (§3); TS ignores unknown top-level files
├── oauth.json                       [C]  # LEGACY pre-auth.json auth store; read-only migration source (migrations.ts L35-95)
├── prime-agent-debug.log            [L]  # client debug log at agentDir root (config.ts L635-638)
│
├── sessions/                        [S]  # append-only session JSONLs, flat: <session-id>.jsonl (schema v3 header)
│   └── <session-id>.jsonl                 # first line: v3 session header (§4.3)
├── archive/                         [S]  # NEW, Rust-only: retention output, sibling of sessions/ in the session root (§5.2)
│   └── sessions/<session-id>.jsonl.gz [S]  # gzip of archived session JSONLs; restore-on-resume decompresses back (§5.2)
├── session-artifacts/               [S]  # sibling of sessions/ (dirname(sessionDir)/session-artifacts)
│   └── <session-id>/
│       ├── harness/
│       │   ├── harness_state.json   [S]  # session-local continual-harness state (refinement.ts L303-307)
│       │   └── refinements.jsonl     [S]  # session-local refinement history (refinement.ts L18, L384)
│       ├── kernel-state.dill        [S]  # Python kernel snapshot, dill payload (kernel/state-snapshot.ts L17-41)
│       ├── kernel-state.json       [S]  # per-object snapshot manifests (same file family, state-snapshot.ts)
│       ├── kernel-stderr.log       [L]
│       ├── scheduled-jobs.json     [S]  # session heartbeat/cron jobs (cron-jobs.ts L104)
│       ├── semantic-edges.jsonl    [S]  # ACP semantic-edges-v1 ledger (semantic-edges.ts L32)
│       ├── sub-<child-short-id>/         # RLM child sessions live INSIDE the parent's artifact dir
│       │   ├── <child-session-id>.jsonl [S]  # child session JSONL (same v3 row format)
│       │   ├── rlm-subagent.json     [S] # child topology record (modes/daemon/rlm-subagent-display.ts L10)
│       │   └── semantic-edges.jsonl  [S]
│       └── session-artifacts/<grandchild-id>/ [S]  # recursion: each child gets its own artifact subtree
│
├── harness/                         [S]  # GLOBAL continual-harness state (refinement.ts L299-307)
│   ├── harness_state.json           [S]  # memories/skills/subagent specs/prompt notes; survives upgrades
│   └── refinements.jsonl            [S]  # global refinement history (refinement.ts L18, L384)
│
├── rlm-ledger/                      [S]  # daemon RLM ledger family (modes/daemon/rlm-ledger.ts L38)
│   └── <sha256-12hex>.jsonl         [S]  # one ledger per tree; durable truth incl. child lineage
├── session-leases/                  [S]  # transient write locks guarding session files (session-lease.ts L70, L307)
│   └── <hash>.lock
├── daemon-workers/                  [S]  # supervisor per-worker descriptors, keyed by socket hash (daemon-ps.ts L1018)
│   └── <worker-key>/
│       ├── supervisor-config        [S]  # supervisor truth for the worker (daemon-supervisor.ts L241)
│       └── <worker-id>.recovery.jsonl [S] # command recovery journal (daemon-supervisor.ts L1353)
├── daemon-update-restarts/          [S]  # restart manifests (config.ts L569-572)
│   └── <socket-hash>.json           [S]
├── daemon-update-restart.json       [S]  # legacy single-socket manifest (config.ts L575-577)
├── agent-traces-outbox/             [S]  # trace outbox: uploaded-then-removed JSON payloads (agent-traces.ts L651)
│   └── <md5>.json
├── logs/                            [L]  # all diagnostics (config.ts L540-566); 5 MiB single-generation rotation
│   ├── agent.jsonl                  [L]  # shared structured JSONL: client, daemon, provider
│   ├── client-errors.log            [L]
│   ├── agent-traces.log             [L]
│   └── daemon.sock.<hash>.log       [L]  # per-socket daemon log (config.ts L563-566)
│
├── skills/                          [C]  # user skills (resource-loader.ts L648; skills.ts L571)
├── prompts/                         [C]  # user prompt templates (prompt-templates.ts L204)
├── themes/                          [C]  # custom themes (config.ts L535-538)
├── extensions/                      [C]  # user extensions (extensions/loader.ts L574)
├── git/<host>/<path>/               [S]  # git-sourced installed packages, global scope (package-manager.ts L1865-1868)
├── bin/                             [K]  # managed binaries fd, rg (config.ts L616-619; tools→bin migration)
└── kernel-venv/                     [K]  # Python kernel venv; user may delete, product rebuilds (kernel/bootstrap.ts L373)
```

Paths OUTSIDE the agent dir that the layout contract covers:

```
<cwd>/.prime/agent/                       # project scope: settings.json, skills/, prompts/, themes/, extensions/,
│                                         #   npm/node_modules/ + git/<host>/<path>/ package stores (package-manager.ts L1831-1838)
~/.agents/skills/                         # user-level agent skills, plus ancestor dirs of cwd (package-manager.ts L2151, L439)
$TMPDIR/prime-agent-<uid>/daemon.sock     # daemon socket (§2.1)
$TMPDIR/pi-extensions/...                  # temporary-scoped package checkouts (package-manager.ts L1888)
```

Note for reviewers: `~/.prime/agent/retired-sessions/` exists on this box but
does NOT exist in the TS sources; it is a sandbox-infra artifact, not a product
path. It is excluded from the contract (see open question Q2).

### 2.3 Class justification for the non-obvious cases

- `models.json` is `config`, but `prime-inference-models-cache.json` is
  `cache`: the MISSION requirement ("custom or internal endpoints must not
  depend on API listing") is exactly this class split. The cache may be
  overwritten by a network-scoped `/models` response; `models.json` must never
  be clobbered by a fetch.
- `git/<host>/<path>/` package store is `state`, not `cache`: deleting it
  changes what the user sees (an installed package disappears), but it is
  reinstallable without user data loss. Deleting a `state` path is still only
  allowed via explicit user action (e.g. package uninstall), which is exactly
  how TS treats it (`removeGit`, package-manager.ts).
- `daemon-workers/`, `session-leases/`, `daemon-update-restarts/` are `state`
  even though they are runtime supervisory data: they are the durable truth
  the supervisor redesign relies on across restarts (worker adoption,
  recovery, idempotent replay). They are recreated on boot when absent, which
  makes them cheap to lose — but the class records what the product may
  promise: no upgrade may silently drop them.
- `kernel-venv/`, `bin/`, `semantic-edges` outputs where regenerable, and the
  models cache are the only `cache` entries; everything else generated is
  `state` because TS persists it as durable truth.

## 3. Layout manifest and layout version

### 3.1 Why a manifest

Multi-install is descoped (§4.5), so the Rust product and TS share one agent
dir per user. The manifest exists for three narrow jobs:

1. Record that the Rust product has adopted this agent dir, and at which
   layout version — the gate for any future explicit migration.
2. Record the one-time TS import/verification stamp (§4.4) so first-run work
   never repeats and support can see provenance.
3. Detect a layout newer than the running product understands (forward
   incompatibility), instead of failing with opaque per-file errors.

It is NOT a path-remapping mechanism: every path in §2.2 is positional and
fixed. If a future change needs a path table in the manifest, that change must
first amend this design.

### 3.2 Schema: `layout.json` (agent dir root)

Written atomically (temp file + rename + fsync, matching TS
`writeFileAtomicSync` durability rules). Mode 0600 — it carries no secrets,
but it is product-internal.

```jsonc
{
  "kind": "agent-dir-manifest",     // literal; discriminator for future readers
  "layoutVersion": 1,               // u32; this design defines 1
  "product": {
    "name": "prime-agent-rs",       // literal; TS writes no manifest
    "version": "<crate version>",   // semver of the writing binary
    "adoptedAt": "<RFC 3339>"       // first adoption time; set once, never rewritten
  },
  "tsImport": {                     // present iff the one-time import ran (§4.4)
    "importedAt": "<RFC 3339>",
    "tsVersion": "<detected TS version or null>",
    "checksPassed": [               // verbatim check ids from §4.4; grows only
      "auth.json.parse", "settings.parse", "models.json.parse",
      "sessions.v3.header.scan", "resources.paths.resolvable"
    ],
    "checksFailed": []              // non-fatal findings; surfaced in first-run UI
  },
  "updatedAt": "<RFC 3339>"         // touched on every manifest write
}
```

Rules:

- `layoutVersion` monotonically increases; readers must refuse to operate
  (read-only diagnostics mode) when they find a HIGHER version than they
  understand, and must operate normally on the same version. Lower is normal
  (old dirs simply have no manifest; absence of `layout.json` means "TS or
  pre-manifest Rust layout, run first-run import/verify").
- The manifest is additive-only across versions: fields are added, never
  repurposed; unknown fields are preserved verbatim on rewrite.
- TS tolerance: the TS product scans the agent dir only for known names
  (`migrations.ts` scans top-level `.jsonl` only; settings/auth/resource
  readers open fixed paths). A new top-level JSON file is invisible to TS, so
  `layout.json` does not break downgrade-to-TS. This must stay true
  (verification V3, §4.6).

### 3.3 Lifetime-class registry

The class table in §2 is documentation-now, registry-later: the importer and
any future retention work consume a single machine-readable table of
`{logicalName, relativePath, class}`. That table is generated from §2.2 and
lives in `crates/pa-types` (pure data, no behavior), not in the manifest — the
manifest records version/provenance; the binary knows the tree it implements.
If the two disagree, the manifest's `layoutVersion` decides which table
applies.

## 4. TS backward compatibility contract (HARD SHIP-BLOCKER)

The Rust product is an UPGRADE of an existing TS install, not a fresh install.
A user who upgrades keeps everything below, verbatim, at the same paths. This
section is release-blocking: the v1.0 ship checklist must show evidence for
every item in §4.6.

### 4.1 (a) Login state — NO re-login

- `auth.json` is the only credential store (`auth-storage.ts` L102, L282).
  Shape: `{ "<provider>": { "type": "api_key", "key": "..." } | { "type": "oauth", ...tokens, expiry } }`.
- The Rust product reads, refreshes, and writes THIS file, in THIS format, at
  THIS path, with mode 0600 preserved, honoring `auth.json.lock` through the
  platform file-lock trait (flock today, LockFileEx slot per
  `docs/windows-readiness.md`).
- OAuth refresh writes must keep unknown provider entries untouched
  (read-modify-write on the whole map, never a blind overwrite).
- Legacy fallbacks, read-only, only when `auth.json` is absent: `oauth.json`
  and `settings.json:apiKeys` (the exact TS migration sources,
  `migrations.ts` L35-95). The Rust first-run must NOT rename or rewrite those
  sources (§4.4); it materializes `auth.json` only if TS never did and the
  user confirms.
- A Rust-side OAuth flow must be able to write the same `oauth` entry shape TS
  reads, so a user can downgrade without re-login either.

### 4.2 (b) Settings and custom model providers

- `settings.json` (global at agent dir root; project at `<cwd>/.prime/agent/`)
  is read and written with TS field compatibility: unknown keys are preserved
  verbatim on any Rust write (read-modify-write, never a typed-serialize
  blind overwrite).
- `models.json` user-declared entries (id, provider, endpoint, pricing,
  context window) are `config` (§2.3): they must survive every catalog
  refresh. The network-scope cache
  (`prime-inference-models-cache.json`) may be replaced; user entries must
  never be dropped, reordered into the cache, or shadowed by a same-id cache
  entry. Custom entries win on conflict.
- The `settings.json.lock` / `auth.json.lock` convention (lock file beside the
  payload) is part of the wire contract; the Rust lock implementation must take
  the same adjacent-path lock, not a new location.

### 4.3 (c) Full session history

- `sessions/<session-id>.jsonl` files created by TS must resume in the Rust
  product with full context. First line is the session header:
  `{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"...","rlmDepth":0}`
  (observed live on this box; also the row family PR #68 built against).
  **Session-row schema v3 stays wire-compatible**: the Rust product may add
  new entry types only under a future bump (see Q1), and unknown `type`
  values must be skipped-with-counter, never dropped from the file on
  rewrite. Files are append-only; no in-place rewrites.
- Session dirs are flat; the legacy `--cwd--` nested form
  (`migrations.ts` L130-207) may still exist on old installs and must remain
  listable (TS moves them; the Rust product at minimum reads them, and
  should port the same flattening migration behind `layoutVersion`).
- `session-artifacts/<session-id>/` (harness/, kernel-state.*, scheduled-jobs,
  semantic-edges.jsonl, `sub-*` child trees) is read with the same meanings
  (§2.2); RLM children of a resumed TS session must show in the roster from
  `sub-*/rlm-subagent.json` + child JSONLs.
- The `PRIME_AGENT_SESSION_DIR` env override and cwd-scoped `sessionDir`
  setting keep the same precedence (`config.ts` L621-639), or upgraded users
  with redirected session roots see "empty" history.
- Rust-created sessions are resumable by TS (bidirectional interop already
  verified in PR #68, `pa-cli: headless sessions persist to disk`); every
  later row-format change re-runs that differential gate.

### 4.4 Importer: one-time, READ-ONLY

The Rust first-run adoption step, run when `layout.json` is absent:

1. Resolve the agent dir (§2.1) and check presence/parseability of:
   `auth.json` (plus legacy `oauth.json`/`settings.json:apiKeys`),
   `settings.json` (global + project), `models.json`,
   `sessions/*.jsonl` headers (schema v3 scan, count reported),
   resource dirs (`skills/`, `prompts/`, `themes/`, `extensions/`,
   `git/<host>/<path>/`, `keybindings.json`, `~/.agents/skills`).
2. Record results in `layout.json.tsImport` (§3.2). Findings are surfaced to
   the user (e.g. "3 sessions use unknown entry types; they will be skipped in
   context but preserved on disk"), never auto-"fixed".
3. WRITE NOTHING ELSE and DELETE NOTHING. The TS layout is untouched: no
   renames, no migrations of `oauth.json`/`tools/`/`commands/` (TS already
   did its own; if the TS migration never ran, that is TS's to do on
   downgrade, not ours on upgrade). The importer is a compatibility
   verification with a manifest stamp, not a data mover — because the layout
   is shared, there is nothing to move.
4. Re-run never happens automatically: presence of `layout.json` suppresses
   it; a `--recheck` diagnostic may re-run read-only.

### 4.5 Multi-install is descoped

One install per user. Dev workflows that need a second install use
`PRIME_AGENT_CODING_AGENT_DIR` (and the session-dir env), which both TS and
Rust honor at the same precedence (§2.1). The Rust/TS lock incident on this
box is recorded as a dev-tooling lesson only — it is why lock files must be
advisory, adjacent-path, and stale-reclaiming (`session-leases` semantics,
`session-lease.ts`), not why the product needs side-by-side dirs.

### 4.6 Ship-blocker verification battery (evidence required before v1.0)

- V1 — auth roundtrip: a TS login (real `auth.json` fixture, oauth shape with
  expiry) is read by the Rust binary, a refresh is written back, and the TS
  binary still authenticates. No re-login prompt anywhere in the flow.
- V2 — settings/models preservation: install with a `models.json` custom
  provider + `settings.json` extras; run a Rust catalog refresh; assert
  `models.json` byte-equal (modulo nothing) and custom entry still resolves;
  assert TS `prime-agent models` lists it.
- V3 — downgrade tolerance: after Rust adoption (manifest present, sessions
  written by Rust), run the TS binary on the same dir; assert list/continue
  works and no TS crash on `layout.json`.
- V4 — session interop: golden TS session JSONLs (captured from
  `~/.prime/agent/sessions`) resume in Rust and produce equivalent first-turn
  context; Rust-written sessions resume in TS (extends the PR #68 differential).
- V5 — importer idempotence + purity: run first-run twice; assert identical
  manifest (modulo timestamps) and assert the TS tree is byte-identical
  (snapshot hash before/after importer).

## 5. Retention policy

TS evidence first: **TS has no retention subsystem.** No session
deletion, archiving, or compression code exists in `packages/coding-agent`;
session files are append-only and kept forever. The only bounded paths are
the 5 MiB single-generation `appendRotatingLog` rotation (config.ts L579-614)
and the traces outbox, whose payloads are removed once uploaded
(agent-traces.ts L724+). `SessionStateStatus = "archived"` (session-manager.ts
L175) is a session *status* derived from entries (`"hidden"`/`"sleep"` →
`archived`), not file retention. Retention is therefore a Rust-side additive
capability, designed here so it can never break a downgrade to TS (§4.6 V3):
every automatic action is either lossless (compress + move + restore-on-demand)
or touches only paths TS treats as disposable or rebuildable.

### 5.1 Ground rules (from the lifetime classes, §1)

- `config` is never touched by retention. Not archived, not pruned, not
  reported as reclaimable.
- `cache` may be deleted at any time, but rebuild cost matters
  (`kernel-venv/` bootstrap is minutes): automatic deletion of `cache` is
  limited to explicit user command or budget enforcement, never age.
- `logs` rotate and trim freely (§5.4).
- `state` deletion happens ONLY through the named tiers below, and every
  move/delete is audited (§5.6).

### 5.2 Session archive (lossless; default on)

- Eligibility: `sessions/<id>.jsonl` whose last activity (last user/assistant
  message timestamp, the same derivation as TS session-manager
  `updateLastActivityTime`; fallback to file mtime) is older than
  `sessionArchiveDays` (default 90), and which is not the currently running
  session and not referenced by a live daemon worker (`daemon-workers/`).
- Action: gzip (`flate2`, level 6) to `archive/sessions/<id>.jsonl.gz`
  (`archive/` is a sibling of `sessions/` in the session root, so redirected
  session roots get their own archive), fsync the `.gz`, then unlink the
  original. A crash between write and unlink at worst leaves both; the next
  pass dedupes (compressed copy wins, original unlinked).
- Resume by id transparently decompresses back into `sessions/<id>.jsonl`;
  the session is live and TS-visible again (byte-identical content — the
  archive never rewrites rows).
- Listing shows archived sessions marked; TS's session list naturally does
  not see them (files no longer under `sessions/`). Accepted; recorded in the
  compat matrix (§7.3) and surfaced in the disk report (§5.5).

### 5.3 Artifact pruning (lossy; default on; tiered)

- Tier 1 — kernel snapshots: `session-artifacts/<id>/kernel-state.dill` and
  `kernel-state.json` are deleted when the session has been inactive longer
  than `kernelSnapshotDays` (default 30). Cost: kernel cold-start on resume.
  This closes Q7: the class stays `state` (they are per-session durable
  truth), and this tier is the sanctioned cheap reclaim.
- Tier 2 — full artifact dir: `session-artifacts/<id>/` (harness state,
  ledgers, child trees, journals) is deleted when the session has been
  archived for `artifactDays` (default 180 — i.e. ~270 days of total
  inactivity at the 90-day archive default), or inactive ≥ 365 days even if
  never archived.
- Never: the running session, sessions referenced by live daemon workers,
  anything modified in the last 24 hours (crash safety), anything under a
  `config` class.

### 5.4 Log caps

- Per file: TS parity — 5 MiB rotation, single `.old` generation (so ≤ ~10
  MiB per log file). Applies to every file in `logs/` and to
  `prime-agent-debug.log` at the agent dir root.
- Per dir: `logs/` soft cap `logDirCapBytes` (default 64 MiB). Above it:
  delete `.old` generations first, then `daemon.sock.<hash>.log` files older
  than 30 days beyond the newest 4.
- `logs/retention.jsonl` (§5.6) follows the same 5 MiB rotation.

### 5.5 Disk budget report

- New additive CLI command `prime-agent disk-usage` (TS has no equivalent;
  additive commands do not affect parity). Output: byte totals per lifetime
  class (config / state / cache / logs, plus archive), the 10 largest
  sessions and artifact dirs, `kernel-venv/` + `bin/` sizes, and a dry run of
  the next retention pass (what would move or prune, bytes reclaimed, which
  tier). No side effects.
- Defaults live under `settings.json:retention` (an unknown key to TS —
  preserved verbatim by the §4.2 read-modify-write rule): `enabled: true`,
  `sessionArchiveDays: 90`, `kernelSnapshotDays: 30`, `artifactDays: 180`,
  `logDirCapBytes: 67108864`, `agentDirWarnBytes: 10737418240` (10 GiB).
  `agentDirWarnBytes` is advisory only: budget enforcement auto-acts on
  `cache` + `logs` alone; `state` actions follow §5.2/§5.3 regardless of
  budget pressure.

### 5.6 Execution and audit

- A retention pass runs at most once per 24 h, on the daemon when idle, or
  explicitly via `prime-agent retention --dry-run|--run`. It never runs
  during session writes and takes the same advisory, stale-reclaiming locks
  (§4.5) before touching a file.
- Every move or delete appends one JSONL record to
  `logs/retention.jsonl`: `{path, action, tier, bytes, reason, timestamp}`.
- Verifier V6 (extends §4.6): a golden agent-dir fixture (TS-created) → run
  a retention pass → assert: every `config` byte identical; every archived
  session decompresses byte-identical; the TS binary lists and continues all
  non-archived sessions; `retention.jsonl` accounts for every removed byte.

## 6. Layered model registry

This section replaces the "cache-file surgery" problem named in MISSION.md:
custom or internal endpoints must not depend on API listing, and the TS
failure mode is user-declared models being lost when catalog state is
overwritten by a network-scoped `/models` response. The fix is structural:
each source lives in its own file with its own lifetime class (§2.3), and
there is exactly one merge order.

### 6.1 Layers (base → top; top wins on provider+id conflict)

1. **Bundled** (compile-time, `pa_ai::models_generated`): the baseline
   catalog for every known provider, including the public Prime Inference
   slice and the bundled private-model table
   (`private_prime_inference_models`). Always present, offline-safe.
2. **Account / entitlement** (network state, class `cache`):
   - public PI catalog: `prime-inference-models-cache.json` — a successful
     `/models` refresh replaces the bundled public PI slice
     (`merge_prime_inference_models`); a failed or missing fetch leaves the
     bundled slice.
   - private entitlements: `prime-inference-private-models.json` —
     team-authorized private models, scoped by fingerprint
     `HMAC-SHA256(api key, team id)` (`private_prime_authorization_fingerprint`),
     TTL 5 min (`PRIVATE_PRIME_AUTHORIZATION_CACHE_TTL_MS`). The bundled
     private table is the floor; fetched entries extend it.
3. **User** (`models.json`, class `config`): declared providers/models and
   overrides. Wins on conflict (`merge_custom_models`). A user-declared
   private id (`explicit_private_ids`) is authorized WITHOUT an entitlement
   fetch — user intent outranks the entitlement gate.

### 6.2 Invariants (hard)

- A network response may only ever rewrite a `cache` file. `models.json` is
  written by the user only; no refresh path touches it (V2 in §4.6 asserts
  byte-equality across a refresh; TS also only ever reads it — its sole
  registry write is the private cache file, model-registry.ts L1115).
- Cache validity is fingerprint-scoped: a credential change silently
  invalidates cached entitlements; nothing is deleted on invalidation.
- **Cache-adopt seam (PR #111):** a fresh `ModelRegistry` gates every private
  model out until layer 2 is populated, and only the async refresh does that
  by default. Every SYNC resolve path must call
  `load_private_authorization_from_cache` (network-free, fingerprint-checked)
  before `get_available()` — the #111 bug was exactly one sync path (daemon
  create) missing the adopt. Any new sync resolve path inherits this
  contract; it is a review checklist item, not a convention.
- Auth gating (`has_configured_auth`, stale/expired credential filtering)
  applies AFTER the merge and never removes catalog entries.

### 6.3 Mapping onto the current code (crates/pa-core/src/models)

| design layer | code |
|---|---|
| bundled (1) | `pa_ai::models_generated`, `private_prime_inference_models()` |
| account public cache (2) | `prime_inference_catalog.rs`: `read_cached_prime_inference_models`, `refresh_prime_inference_models`, `merge_prime_inference_models` |
| account entitlements (2) | `private_auth.rs`: `fetch_authorized_private_prime_inference_models`, `PrivatePrimeAuthorizationCache`, read/write cache; `registry.rs`: `authorized_private_models/ids`, `authorized_team_id` |
| cache-adopt seam | `registry.rs::load_private_authorization_from_cache` (callers: `resolve_registry_model`, print runtime) |
| user layer (3) | `custom.rs` parse/validate; `registry.rs::merge_custom_models` (custom wins), `explicit_private_ids` |
| user request auth | `provider_request_configs`, `model_request_headers`, `get_api_key_and_headers` |
| TTL refresh | `refresh()` / `refresh_available_models()` with same-team stale recovery |

No new file and no schema change is needed: the layout already carries both
caches beside `models.json` (§2.2; this unit adds the previously-omitted
`prime-inference-private-models.json` tree entry). What this section adds is
the named contract: three layers, one merge order, user layer on top, caches
purely regenerable.

## 7. Migrator: staged plan and TS compat matrix

### 7.1 Stages

- **Stage 1 — read-only import** (first Rust run on an existing install;
  trigger: `layout.json` absent). Exactly §4.4: verify, surface findings,
  stamp the manifest, write nothing else. The TS tree is untouched; the TS
  binary may run before and after, unchanged.
- **Stage 2 — dual-read/dual-write interop** (the v1.0 ship state). Because
  paths and wire formats are shared (§4), migration is ownership of writes,
  not data movement: the Rust product reads every TS format verbatim and
  writes TS-compatible formats back (auth.json whole-map read-modify-write,
  settings unknown-key preservation, session JSONL v3 append-only). Rust-only
  additions (`layout.json`, `archive/sessions/`, `logs/retention.jsonl`,
  the `settings.json:retention` key) are invisible to TS or preserved
  verbatim. Downgrade to TS stays functional for the entire stage. Exit
  criteria: V1–V5 green (§4.6) plus a differential soak — both binaries run
  against the same agent dir for an agreed period with no compat findings.
- **Stage 3 — native** (only on explicit operator call, TS end-of-life).
  `layoutVersion` may bump to adopt Rust-only formats TS cannot read (e.g. a
  session-row v4 bump per Q1), under the additive manifest rules (§3.2).
  Nothing in v1.0 plans this; every bump is its own design unit first.

### 7.2 Stage-2 ownership rules

- The Rust product never renames or deletes a TS-created file except through
  §5 retention, and retention actions are downgrade-tolerant by construction
  (archive is lossless and restores on resume; pruning tiers act only on
  long-inactive sessions).
- Supervisory state (`daemon-workers/`, `rlm-ledger/`, `session-leases/`,
  `daemon-update-restarts/`) is exempt from the "write TS formats" rule: the
  Rust supervisor owns its own descriptor schemas under the same directories.
  A TS downgrade does not adopt Rust-written worker descriptors — acceptable,
  because supervision is transient and recreated on boot (§2.3). The
  supervisor lane owns the exact schemas (see Q9).

### 7.3 Compat matrix (what each binary reads and writes; stage 2)

| path | TS reads | TS writes | Rust reads | Rust writes | notes |
|---|---|---|---|---|---|
| `auth.json` (+ `.lock`) | yes | yes (refresh, RMW map) | yes | yes (same shape, RMW, 0600) | §4.1; V1 |
| `oauth.json`, `settings.json:apiKeys` (legacy) | yes (one-time migration source) | no (reads only) | yes (fallback when auth.json absent) | NEVER | §4.1; import stays read-only |
| `settings.json` (+ `.lock`) | yes | yes (RMW) | yes | yes (RMW, unknown keys preserved) | §4.2; `retention` key is additive |
| `keybindings.json` | yes | yes | yes | yes | plain JSON |
| `models.json` | yes | **no** (user-authored) | yes | **no** | §6.2; V2 byte-equality |
| `prime-inference-models-cache.json` | yes | yes (atomic) | yes | yes (atomic) | `cache`; §6.1 layer 2 |
| `prime-inference-private-models.json` | yes | yes (atomic) | yes | yes (atomic) | `cache`; fingerprint-scoped; §6.1 layer 2 |
| `sessions/*.jsonl` | yes (v3) | yes (append) | yes (v3, unknown types skipped+counted) | yes (append) | §4.3; V4 |
| `archive/sessions/*.jsonl.gz` | no (invisible) | — | yes (restore on resume) | yes (§5.2) | Rust-only; lossless |
| `session-artifacts/<id>/**` | yes | yes | yes | yes; §5.3 may prune | pruning only ≥ tier ages |
| `harness/{harness_state.json,refinements.jsonl}` | yes | yes | yes | yes | global continual harness |
| `rlm-ledger/*.jsonl` | yes | yes | yes | Rust schema | §7.2 exemption; Q9 |
| `session-leases/*.lock` | yes | yes | yes | Rust semantics (advisory, stale-reclaim) | §7.2 exemption |
| `daemon-workers/**` | yes (adopt on downgrade) | yes | yes (TS-era files, best effort) | Rust schema | §7.2 exemption; transient |
| `daemon-update-restarts/**` | yes | yes | yes | Rust schema | §7.2 exemption |
| `agent-traces-outbox/*.json` | yes | yes (upload-then-remove) | yes | yes | upload semantics preserved |
| `logs/**`, `prime-agent-debug.log` | yes | yes (5 MiB rotation) | yes | yes (same rotation, §5.4 caps) | diagnostics |
| `logs/retention.jsonl` | no (invisible) | — | yes | yes | Rust-only audit log |
| `skills/ prompts/ themes/ extensions/` (agent dir + project + `~/.agents/skills`) | yes | no (user-installed) | yes | no | `config` class |
| `git/<host>/<path>/`, `npm/` stores | yes | yes (install/remove) | yes | yes (same layout) | uninstall = explicit user action |
| `cron-jobs.json` | yes | yes | yes | yes | |
| `telemetry.json` | yes | yes | yes | yes | |
| `layout.json` | **no** (unknown top-level file, ignored) | — | yes | yes | §3.2; V3 asserts the ignore |
| `bin/`, `kernel-venv/` | yes | yes (bootstrap) | yes | yes (rebuild) | `cache`; reclaimable |
| `$TMPDIR/prime-agent-<uid>/daemon.sock` | yes | yes | trait slot | trait slot | §2.1; not agent-dir state |

Matrix invariants: every row where TS reads = yes must keep the TS parse
succeeding after any Rust write (that is what V3 checks mechanically); every
Rust-only row must stay invisible-or-preserved for TS.

## 8. Open questions (for review)

- **Q1 — session-row schema evolution.** Freeze at v3 forever (new entry
  types under the same version, TS-tolerance permitting), or define a v4 bump
  process now? TS currently skips unknown `type` values on resume — needs a
  targeted verifier before we rely on it. Per §7.1, a v4 bump is a stage-3
  decision anyway.
- **Q2 — `retired-sessions/` on this box.** Not in TS sources; appears to be
  sandbox-infra. Confirm with infra owners; if it is a real product path in a
  newer TS build, the tree in §2.2 gains a `state` entry.
- **Q3 — `git/` package store class.** `state` per §2.3 (reinstallable but
  user-intent). Alternative: introduce a `package-store` class to make
  reinstall-cheap explicit. Prefer no fifth class until retention design
  needs it. Retention (§5) does not need it: stores are `config`-adjacent
  user intent and are never auto-pruned.
- **Q4 — `tsImport.tsVersion` detection.** TS does not write a version stamp
  in the agent dir. Detect via `prime-agent --version` if the TS binary is on
  PATH, else `null`? Or stamp the TS package version only when it can be
  proven, never guessed?
- **Q5 — manifest write timing.** Adopt (write `layout.json`) before or only
  after all importer checks pass? Writing early gives provenance on
  crash-during-first-run; writing late keeps "manifest present ⇒ verified"
  a strict invariant. Current lean: write the manifest immediately with
  `checksPassed: []` and update it as checks pass (crash-resumable), since
  absence-of-manifest is the importer trigger either way.
- **Q6 — project-scope `.prime/agent/` in VCS'd repos.** `settings.json` and
  resource dirs are user-committable; the package stores (`npm/node_modules`,
  `git/`) are not. Confirm whether the doc should also pin the `.gitignore`
  convention for the project dir (TS writes `.gitignore` into package roots
  only, `package-manager.ts` L1816-1823).
- **Q7 — `kernel-state.dill` class.** RESOLVED by §5.3 tier 1: class stays
  `state`; retention grants the 30-day age-based reclaim. No reclass needed.
- **Q8 — retention defaults sign-off.** §5 proposes: archive 90 d, kernel
  snapshots 30 d, artifacts 180 d post-archive, logs cap 64 MiB, warn at
  10 GiB, retention enabled by default (archive and pruning are automatic;
  both are reported in `retention.jsonl` and reversible/dry-runnable).
  Operator: confirm the numbers and the default-on consent model, or pin
  different ones before implementation.
- **Q9 — supervisory-state schema divergence.** §7.2 exempts
  `daemon-workers/`, `rlm-ledger/`, `session-leases/`,
  `daemon-update-restarts/` from TS-format writes. Confirm the supervisor
  lane owns Rust schemas in-place (TS downgrade does not adopt them), vs.
  keeping TS formats there for full downgrade parity.
- **Q10 — `disk-usage` / `retention` command surface.** Additive Rust-only
  commands do not affect TS parity, but they do appear in `--help`. Confirm
  the CLI lane should add `prime-agent disk-usage` and
  `prime-agent retention --dry-run|--run`, or fold both into an existing
  command shape.
