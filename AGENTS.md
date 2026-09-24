# AGENTS.md

Development rules for Prime Agent (Rust) on PrimeIntellect-ai/prime-agent, branch `rust`.
Adapted from the Prime Agent (TS) repo rules.
Every contributor (human or agent) must read this before working on this repo.

## Repository

- The repo is PrimeIntellect-ai/prime-agent; the Rust implementation lives on the `rust` branch
  (the personal kevinjosethomas/prime-agent-rs repo is archived for provenance).
- PRs go to the org repo with base `rust`:
  `gh pr create --repo PrimeIntellect-ai/prime-agent --base rust`.
- CI runs on the org's billing: `.github/workflows/continuous.yml` + `release.yml` on the
  `rust` branch.
- Parity ground truth is unchanged: the TS checkout at ~/prime-agent (read-only).

## Style and structure

- Workspace crates are prefixed `pa-`. The hard ownership rules: one owned area per crate,
  pa-types is the only shared crate, cycle-free dependency direction, minimal public APIs,
  no god-modules. The dependency direction is pinned in the Crates table below; each crate's
  README.md states its scope, non-goals, and public API surface.
- Prefer private modules with an explicitly exported public crate API. Internals are `pub(crate)`.
- Avoid large modules — and this is enforced, not aspirational (see the LOC ratchet below).
  New `.rs` files stay under 500 whole-file lines (tests included); if in-file tests would push a
  module over, put the tests in a dedicated test module or `tests/` file instead. Past ~800 lines,
  put new functionality in a new module unless there is a strong documented reason not to. Be
  hardest on high-touch orchestration files (session engine, daemon supervisor, TUI app): those
  attract unrelated changes, so split early.
- When extracting code from a large module, move the related tests and docs with it so invariants
  stay close to the owning code.
- Inline format args: always prefer `format!("{x}")` over positional.
- Collapse if statements per clippy::collapsible_if.
- Prefer method references over closures per clippy::redundant_closure_for_method_calls.
- Make `match` statements exhaustive; avoid wildcard arms.
- New traits need doc comments explaining their role and how implementations are expected to behave.
- No opaque positional `bool`/`Option` parameters (`foo(false)` is unreadable). Prefer enums,
  named methods, or newtypes. If you must pass an opaque literal by position, use an exact
  `/*param_name*/` comment matching the callee signature.
- Prefer native RPITIT trait methods with explicit `Send` bounds
  (`fn foo(&self) -> impl Future<Output = T> + Send;`) over `#[async_trait]` or
  `#[allow(async_fn_in_trait)]`. Implementations may use `async fn` when they satisfy the contract.
- No single-use helper methods. Do not create a helper referenced only once.
- Instrument async work at the definition (`#[tracing::instrument(...)]`), not with
  `.instrument(...)` at call sites. Check whether the callee is already instrumented first.

## Change hygiene

- If you change dependencies (`Cargo.toml`), regenerate/commit `Cargo.lock` in the same change.
- If a change starts forcing edits across many crate internals, stop and fix the boundary instead.
- Cache-prefix stability is first-class: never adopt a pattern without checking its effect on the
  cacheable prompt prefix (cross-check against ~/codex).

### LOC ratchet (enforced: `make loc` / `.github/workflows/codebase-health.yml`)

- The metric is the whole-file physical line count of every tracked `.rs` file
  (what you see when you open it); `scripts/loc-baseline.json` is the state.
- New files are held to the 500-line default ceiling. Files that were already
  over 500 when the ratchet landed (2026-09-24, tip d8bb6c57b) are frozen at
  their measured size: the entry can only go DOWN. A PR that shrinks a frozen
  file re-records the win with `python3 scripts/check_loc.py --update-baseline`
  (the check fails on an unrecorded win, so the improvement becomes the new
  ceiling and cannot be given back). When a file drops to the default ceiling
  or below, its entry retires and the default governs it again.
- Raising a ceiling or landing a new over-ceiling file is a hand-edited
  `loc-baseline.json` diff that must carry a `reason` (CI fails entries without
  one). That diff is the review surface: reviewers challenge raises.
- Splitting a frozen file is always a win: extract a module (move its tests
  with it), re-run `--update-baseline`; the new file starts under the default
  ceiling or needs its own justified entry.
- Design precedent: the TS repo's frozen test-policy debt baseline — counts
  only go down, wins get recorded, exceptions are justified inline. It exists
  so the port does not repeat the TS repo's giant-file era, where high-touch
  files accreted features until cleanup cost more than the features; the
  2026-09-24 tip already holds worker.rs at 10,992, agent_engine.rs at 9,838
  and session_ui.rs at 9,442 lines.

## Tests

- Prefer whole-object equality comparisons over field-by-field checks.
- Do not add tests for statically defined values.
- Do not add negative tests for logic that was removed.
- Verifiers over self-assessment: tmux user-level tests, differential tests against the TS binary
  on PATH, golden corpora replayed against real captured data. No lane merges without its verifier
  passing, rerun by the reviewer where feasible.
- Test stability (the TS repo froze 767 wall-clock timers/polls in 130 test files before anyone
  counted — TS PR #2495; every flake costs the fleet a classification cycle):
  - No fixed sleep, polling loop, or timeout as a readiness signal; await the concrete event.
    A timer may bound failure; it must not make a test pass.
  - No retry-to-green wrappers. A flaky test is made deterministic or deleted, never skipped.
  - Regressions land in the existing suite of the module that broke (issue number in the test
    name); one test file per source module. Deleting code deletes its tests.
  - A change should not add more lines of test than source; a test-only change deletes at least
    as many test lines as it adds.
- An inline `#[allow(clippy::...)]` (or lint allow) carries the reason in a comment — the deny.toml
  pattern: every exception states why.

## Merge gates

- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace` must pass before every merge. Run `make check` — the local mirror of
  the same gates; CI runs on the org's billing (`.github/workflows/continuous.yml` + `release.yml`
  on the `rust` branch). `make loc` (the LOC ratchet) must also pass — it is part of the
  `codebase-health.yml` workflow and takes seconds.
- **Parity-diff evidence is a merge gate** (the port's definition, not optional polish): every PR
  that touches a user-visible surface must include a "parity-diff evidence" section in its
  description showing the TS-binary comparison for what it changed: (1) rendered output —
  frame-diff vs the TS binary (extend `scripts/visual_parity.py` or the specific harness); 
  (2) interactive behavior — the same input handled identically (keys, mouse, timing); 
  (3) wire parity — byte-compare the TS daemon's traffic for protocol changes; (4) user-visible
  invariants — every user action produces the same visible reaction as TS (`/compact` shows
  started+completed; `/model` shows the selector; a refinement shows its decoration). A feature
  that "works" but was never diffed against the TS binary does not pass review. If TS shows it,
  Rust shows it identically; if Rust shows something TS does not, that is also a parity bug.
- PRs must state ownership compliance (crate README scope/non-goals/public API, dependency
  direction) and classify the change: internals, new `pub` surface, or a new
  dependency/cross-crate re-export. The latter two are architectural changes (rust-analyzer's
  taxonomy): "adding an innocent-looking `pub use` is a very simple way to break encapsulation."
- Generated data plumbing is edited via its generator, never by hand
  (`crates/pa-ai/src/models_generated.rs` regenerates via `scripts/generate-models.py`; the
  module-size rules do not apply to it because its size tracks the TS catalog, not logic).

## Adoption telemetry

Every user-visible feature ships its adoption telemetry event in the same PR as the feature:
the event name + properties are added to `docs/telemetry-events.md` (schema versioned), and a
seam emits it from day one. Telemetry properties never carry prompt, session, or file content
(primitives only; see `pa-telemetry` and the privacy contract in `docs/telemetry-design.md`).

## Branding

The product is Prime Agent - we are not a pi fork. Scrub "pi"/"pi-mono"/"pi-ai"/
"Prime Intellect"-style naming from all user-visible surfaces (docs, READMEs,
CLI help text, error messages, splash/onboarding strings, keybinding hints, TUI
labels, and code comments that quote user-facing strings); brand everything
Prime Agent. Audit with a repo-wide grep and classify every hit (user-visible
vs wire-internal vs comment) before scrubbing, and list the preserved wire
identifiers in the PR body so the reviewer can verify none were wrongly scrubbed.

EXPLICIT EXCEPTION: wire-protocol identifiers that must stay byte-compatible with the TS product (e.g. the PI_PACKAGE_DIR env var, settings keys, provider IDs like prime-inference, harness _meta namespaces like ai.primeintellect.prime-agent, lockfile names) stay until/unless the TS side renames them — PARITY BEATS BRANDING ON THE WIRE.



## Surface contract (must not change)

- Tools exposed to the model: `bash`, `edit`, `ipython` (internal helpers: `rename`, `stdout`).
- RLM kernel API in the persistent Python REPL: `rlm.spawn/find_models/collect/list_subagents/delete_subagent/create_session/progress_note`, `rlm.harness` CRUD, `agent_message.send`, `agent_observe`, `compact`, `goal`, `refine`, `attach_image`, skills (markdown + Python) per the skill contract in the base system prompt.
- System prompt structure: layered — cache-stable static layer files (core harness description with the full API surface, mandatory usage rules, opinionated guidelines, per-model map) followed by one dynamic tail (packages, project context, skills inventory, MCP servers, environment, session role); the harness digest stays a separate `[harness-digest]` user message. `prime-agent prompt` dumps the assembled prompt with its layer breakdown.
- CLI shape: `prime-agent` with the same commands/flags as the TS product; headless modes (RPC/daemon/session-worker) with identical behavior.

## Crates

| crate | role |
|---|---|
| `pa-types` | shared wire & domain types, protocol messages |
| `pa-telemetry` | event schema, queueing/batching, sinks |
| `pa-ai` | providers, model registry, streaming |
| `pa-models` | live model catalog: fetch, no-cold-start chain, transport pinning |
| `pa-agent` | agent loop |
| `pa-core` | session engine: tools, skills, prompts, compaction, refinement, kernel/RLM manager, subagents, session manager, settings |
| `pa-daemon` | supervisor + per-session worker processes, wire protocol, cloud sandbox attach |
| `pa-tui` | terminal UI (ratatui) |
| `pa-cli` | binary `prime-agent` |

Dependency direction (hard rule, cycle-free, enforced in Cargo.toml and at review):

```
pa-types  <-- shared vocabulary, nothing else is shared
pa-telemetry <-- telemetry library; depends on no workspace crate
pa-ai (providers/registry)
pa-models (catalog) --> depends on pa-ai
pa-agent (agent loop) --> depends on pa-ai, pa-types
pa-core (session engine) --> depends on pa-agent, pa-ai, pa-models, pa-types, pa-telemetry
pa-daemon (supervisor/workers) --> depends on pa-core
pa-tui (terminal UI) --> depends on pa-types, pa-core (session wire)
pa-cli (binary) --> depends on everything, the composition root
```

## Reliability model

- The daemon is a supervisor: it spawns one worker process per active session instead of hosting sessions in-process. Workers are supervised, restarted with backoff, and sessions persist on disk (append-only JSONL, same layout as `~/.prime/agent/sessions`) so reattach works even if the supervisor restarts.
- No stubs, no `todo!()`, no swallowed errors (`anyhow` bubbling to UI is fine).

## References

- `docs/` contains the design documents (the parity battery, the installer CI, the extensions runner, the model surface, the session engine port, the completion matrix, the keybindings).
- `docs/FEATURE_PARITY.md` is the exhaustive interactive-mode audit: every TS component walked and verified against the Rust implementation.
