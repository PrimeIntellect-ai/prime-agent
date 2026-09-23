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
4. Update manager_catalog.rs tests (seam builders) + add the 3 hint-matrix unit tests:
   pinned+catalog_available(no service)=hint shows; pinned+no snapshot=hidden, connectable=false;
   service in snapshot=no pin, no hint.
5. Fix pa-daemon/tests/mcp_catalog_e2e.rs: seed the cache as the REAL envelope (wrap REAL_CATALOG fixture
   in {url,scope,fetchedAt,payload}); add the daemon e2e matrix (cache present: hint shows on the vanished
   row; cache absent: no hint, row still there, connectable false). Keep predecessor's shutdown_daemon + mutex.
6. scripts/mcp_hint_parity.py: tmux-level verifier, TS release binary
   (~/.local/share/prime-agent/releases/0.9.5-linux-x64-*/prime-agent, ts_identity fail-fast) vs my build;
   matrix: records for a real catalog service + a vanished one; Rust cache present vs absent; byte-compare
   the hint string.
7. Telemetry: check docs/telemetry-events.md for an /mcp event; add adoption event if the surface warrants one.
8. Sandbox gates (VM rust:1-bookworm per proven recipe; NOT on the box). BASE RED: org/rust tip currently
   FAILS clippy (#2562 match_result_ok in pa-types process.rs); heal PR #2565 is OPEN — wait for it to
   merge, git fetch org rust, rebase, then gates. Do not fix the base red myself.
9. Push: NEW branch -> git-data API (blobs->trees base_tree=<tip tree>->commits->refs) + gh pr create
   IMMEDIATELY (refs can vanish). PR body: parity-diff evidence (tmux frames + source cites), ownership
   compliance, telemetry event. Then: non-benchmark checks green, zero unresolved Bugbot/Macroscope threads,
   merge --squash --admin, verify state==MERGED, goal.complete().

## FACTS
- org remote = `org`; TS checkout ~/prime-agent is STALE pre-#2507 (use `git show org/main:<path>` instead).
- TS hint string (byte-exact): "This service's catalog source is unavailable; its connection keeps the pinned definition."
- pa-core depends on pa-models (Cargo.toml) — MCP_SERVICE_CATALOG_URL + PUBLIC_SCOPE are pa-models publics.
- mcp_view_parity.py = the /mcp frame-diff harness convention to follow for the tmux verifier.
- Predecessor session artifacts: ~/.prime/agent/session-artifacts/01a0a7fa-6fda-75dc-8c7b-e3e00614a6f6/sub-0a4af267/.
