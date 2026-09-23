# LANE-STATE — mcp-hint (MCP catalog-source-unavailable hint gating)

Branch: `mcp-catalog-hint-parity` (worktree ~/lane-worktrees/mcp-hint), base = org/rust tip.
Goal: gate the MCP "catalog source is unavailable" hint to TS-exact conditions; PR merged to org (base rust).
NOTE: predecessor branch `mcp-pinned-hint` (commit ff99bf543, 1h-freshness gate) is DROPPED — that gate
is an invented condition TS does not have. Do not resurrect it.

## ROOT CAUSE (proven)
TS reference: `git show org/main:packages/coding-agent/src/core/mcp/service-catalog.ts` (post-#2507).
- TS hint (lines ~1081, ~1102): fires iff `pinnedFromRecord` (a record whose serviceId is in NO source:
  compiled legacy builtins + declared local sources + remote slice).
- TS remote slice (`currentRemoteMcpEntries`): disk cache `CatalogCache.get("public")` at ANY age
  (last-good; url+scope+fetchedAt validated, payload parsed) ?? packaged bundled asset ?? compiled tiny.
- RUST BUG: `remote_plugins_snapshot` parsed the cache file as a BARE catalog (`{version,counts,entries}`,
  deny_unknown_fields) but the fetch lane writes the SNAPSHOT envelope `{url,scope,fetchedAt,etag,payload:{...}}`
  (proven on-box: ~/.prime/agent/mcp-service-catalog.v2.json is exactly that shape). Parse always failed ->
  cache NEVER served -> packaged bundle absent from the Rust release -> remote slice EMPTY -> every installed
  service pinned -> hint fired on every installed card (Kevin's dogfood noise).

## FIX (in progress on this branch)
1. remote_source.rs: read the REAL snapshot envelope (TS CatalogCache.get parity: url/scope/fetchedAt
   validated, payload parsed, ANY age; legacy locations `<agent-dir>/../mcp-service-catalog.v2.json` and
   `<agent-dir>/../catalog/mcp-service-catalog.v2.json` readable after the primary; `cache_plugins_snapshot`
   separated from the bundled fallback). DONE + unit tests (envelope serves, any age, foreign/bare/garbage
   never serve, legacy/primary precedence). Compile: `cargo check -p pa-core` green after etag field dropped.
2. catalog_plugin_views.rs: PINNED_FROM_RECORD_HINT const; BuildViewsInputs.catalog_available: bool; both
   hint sites gate `pinned_from_record && catalog_available`. DONE.
3. mod.rs McpManager: `catalog_available` field (false at init, set in resolve_service_catalog from
   `remote.is_some()`); manager_catalog.rs threads it into BuildViewsInputs. DONE.
   Rationale (TS product parity): TS always has its catalog in hand, so it never claims "source unavailable"
   it cannot prove; Rust with NO validated snapshot cannot prove absence -> stays silent (the pin itself
   stays: connection remains manageable, TS service-catalog.ts:180-184).
   NOTE: the deny-path variant ("Only an approved saved account endpoint can be repaired...",
   catalog_views.rs:553) is deliberately NOT gated: it follows the pin (TS-main parity, action-time only).

## REMAINING STEPS
4. DONE (committed ffd8ff0fa): 3 hint-matrix unit tests in manager_catalog.rs
   (pinned_hint_shows_when_a_snapshot_proves_the_service_gone / stays_silent_without_a_snapshot /
   stays_hidden_when_the_snapshot_defines_the_service).
5. DONE (committed ffd8ff0fa): mcp_catalog_e2e.rs seeded as the REAL envelope + the daemon e2e
   pinned_hint_needs_a_snapshot_to_claim_the_source_unavailable; pa-models dev-dep; DAEMON_E2E mutex;
   shutdown_daemon; spawn_supervisor env_remove(PI_PACKAGE_DIR). pa-daemon --tests compile green on box.
6. scripts/mcp_hint_parity.py WRITTEN (this session; respawned session lost the draft, rewrote from the
   captured frames + mcp_view_parity/visual_parity conventions): 6-cell tmux matrix
   (ts_vanished/ts_linear via /plugins on the 0.9.5 release binary; rust_vanished_cached/uncached +
   rust_linear_cached/uncached via /mcp on my build), ts_identity fail-fast, batterylib daemon reap,
   records seeded byte-identical both sides, cache = snapshot envelope wrapping the REAL fixture.
   TS-side validation run vs the predecessor-captured ground-truth frames: IN FLIGHT. Release build
   (cargo build --release -p pa-cli) for the Rust side: IN FLIGHT.
7. Telemetry: DONE (checked): no new event warranted — the /mcp dispatch already emits
   `agent command used` (command_name=mcp) and connector actions emit `mcp connector used`; this change
   gates an existing hint's visibility, it adds no new action/surface. State this in the PR body.
8. Sandbox gates (VM rust:1 per proven recipe; NOT on the box). Base = f68799ea4 (#2550 tip; #2565's
   transport.rs hazard is fixed centrally — Context import now cfg-gated, no restore needed).
9. Push: NEW branch -> git-data API (blobs->trees base_tree=<tip tree>->commits->refs) + gh pr create
   IMMEDIATELY. PR body: parity-diff evidence (the 6-cell report + frame cites), ownership compliance,
   telemetry statement. Then: non-benchmark checks green, zero unresolved Bugbot/Macroscope threads,
   merge --squash --admin, verify state==MERGED, goal.complete().

## FACTS
- org remote = `org`; TS checkout ~/prime-agent is STALE pre-#2507 (use `git show org/main:<path>` instead).
- TS hint string (byte-exact): "This service's catalog source is unavailable; its connection keeps the pinned definition."
- pa-core depends on pa-models (Cargo.toml) — MCP_SERVICE_CATALOG_URL + PUBLIC_SCOPE are pa-models publics.
- mcp_view_parity.py = the /mcp frame-diff harness convention to follow for the tmux verifier.
- Predecessor session artifacts: ~/.prime/agent/session-artifacts/01a0a7fa-6fda-75dc-8c7b-e3e00614a6f6/sub-0a4af267/.

## TS-SIDE PARITY RECIPE (proven this session, after 4 failed attempts)
- The deployed 0.9.5 release binary PREDATES the service catalog (#2330): it has NO /plugins, NO
  pinned hint. The predecessor's ground-truth frames came from the TS-MAIN CLI BUNDLE:
  `node ~/prime-agent/packages/coding-agent/dist/bundle/cli.js` (built Sep 21 at 3fc5d967e,
  reports 0.9.5, INCLUDES #2330: /plugins + hint + ServiceCatalogPicker).
- The frames' layout (row + BLANK spacer + ONE detail line + "Enter manage accounts") matches
  TS-main's picker; the Rust /mcp view has an extra detail-head line (sanctioned extension).
- PROVEN boot recipe (visual_parity/queue_edit_parity conventions): faux provider both sides —
  TS via <agent>/extensions/*.js (scripts/ts_faux_extension.js) + PRIME_AGENT_FAUX_SCRIPT,
  Rust natively reads PRIME_AGENT_FAUX_SCRIPT; `--model faux-1`; isolated HOME+TMPDIR; explicit
  --daemon-socket; boot needle "mode (Ctrl+O to expand)" (TS-main=Details mode, Rust=Collapsed).
- WRONG (all caused TUI failures/wrong surface): PI_OFFLINE=1 on TS (blocks kernel venv), real
  --model anthropic/... (provider auth errors), no TMPDIR isolation (hits the SHARED box daemon
  with 13 fleet sessions - NEVER), bare PATH prime-agent (Rust dogfood).
- tmux quirks: pane startup prints a bun-art banner (harmless noise); capture with plain -p
  (-e splits escapes at wrap boundaries); C-u clears the TS editor.
