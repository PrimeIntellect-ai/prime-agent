# MCP service catalog sources

This directory holds the inputs for the MCP service catalog shipped at
`packages/ai/src/mcp/catalog.json`:

- `sources/openai-plugins.json` — pinned snapshot of the 25 remote
  account/SaaS/cloud service MCP configs in OpenAI's public plugins catalog
  (`openai/plugins` @ `1dc195897af4161d039b80d8471ec0a10c9bbc89`).
- `sources/claude-plugins-official.json` — pinned snapshot of the 118 verified
  bundled service plugins (86 direct remote services, 32 stdio SaaS adapters)
  in Anthropic's public catalog (`anthropics/claude-plugins-official` @
  `3deb821cb71ccfaaf2ffa9935e977df314ce5cd5`, resolved to each provider
  repository at its marketplace-pinned commit).
- `overrides.json` — Prime-curated adjustments (id/label/service renames,
  verification and client-registration knowledge, documented exclusions).
  Review data only: it can never add OAuth client ids or secrets.
- `import-report.json` — generated merge report (counts, merges, exclusions).

## Import rules

`npx tsx packages/ai/scripts/import-mcp-catalog.ts` (run from the repo root)
rebuilds the catalog offline and deterministically:

- Each upstream server config becomes a record. Remote streamable HTTP servers
  are grouped by a reviewed endpoint key (lowercased host, trailing slash and
  `utm_*` params dropped) — the same Notion endpoint declared by both upstreams
  is one entry with both provenances. Distinct endpoints (Atlassian v1/v2, Vanta
  regions, Zoom product surfaces) stay distinct entries grouped by a `service`
  brand id; products like Gmail and Google Drive are never merged.
- Upstream OAuth client identities are stripped from the output. Placeholder
  client ids/secrets (`<GMAIL_PUBLIC_CLIENT_ID>` …), Claude-specific client
  identities and provider-branded client ids (OpenAI's and Slack's Slack app
  ids) classify an entry as `requires-setup`; none ever reach `catalog.json`.
- Hosted-only OpenAI app ids are never imported. Loopback endpoints, local
  stdio utilities inside remote plugins, and Claude-app-scoped endpoint
  variants are excluded with reasons recorded in the import report.
- Tenant-URL configs (`${JFROG_URL}/mcp`, `{your-mcp-id}`, …) become
  `http-template` entries with setup fields instead of fabricated endpoints.
  Templates whose variables all have upstream defaults resolve to those
  defaults (logfire/postman/AWS DevOps).
- No upstream scope lists are imported (`reviewedScopes` stays unset); the
  host requests provider-advertised scopes at discovery and owns minimum-scope
  policy.
- stdio SaaS adapters (the Claude catalog's 32) are recorded with their
  commands and flagged `requires-setup`; they are not part of the remote
  one-click lane. A legacy SSE transport is recorded and flagged the same way.
- Everything except the pre-existing `linear`/`notion` integrations ships
  `verification: "unverified"`. Import success is never a readiness claim.

The committed `catalog.json` must always equal the importer output; the
regression test in `packages/ai/test/mcp-catalog.test.ts` rebuilds it from
these fixtures and fails on drift.

## Local user sources

Users can author their own services without a Prime release or a public PR.
The loader (`loadLocalServiceCatalog` from `@earendil-works/pi-ai/mcp`) reads a
single JSON file — proposed settings wiring: `~/.prime/agent/mcp-services.json`
(host-owned) — and enforces the same contract as the bundled catalog:

- version 1, at most 256 KiB and 50 entries;
- full structural validation per entry (see `packages/ai/src/mcp/catalog.ts`);
- provenance may only claim source `user` — vendor or Prime trust cannot be
  asserted by a local file;
- ids colliding with bundled catalog entries are refused (no silent shadowing
  or rebinding of built-ins), as are duplicate ids within the file;
- literal loopback/private/link-local/unspecified endpoints are rejected
  (structural literal-address checks only — DNS/redirect/rebinding policy is
  enforced at request time by the host, not here);
- no execution, no network, and no credentials: OAuth client ids/secrets never
  belong in the file; Prime stores credentials separately when connecting.

A complete authoring example: `examples/local-services.example.json`.

## Refreshing the snapshot

The fixtures are committed so imports need no network and no local research
directories. Interim refresh path (manual): re-read the pinned public upstreams
(read-only HTTP, no plugin execution, no auth) at their pinned revisions — the
marketplace catalog plus each plugin's `.mcp.json`/`plugin.json`, honoring each
loader's conventions (Codex legacy plugins auto-discover a root `.mcp.json`
when the manifest omits `mcpServers`; Claude uses `.mcp.json` plus
manifest-wired config) — update the two fixture files and the pinned commits
in their headers, then re-run the importer and review the `catalog.json` diff.
Fixture entries carry the pinned raw URLs they were derived from.

Remaining item (honest limitation, not yet implemented): a scripted upstream
resolver — an automated fetch mode that regenerates the fixtures from the
pinned public refs end to end. The manual procedure above is an interim
maintainer path and does NOT satisfy that scripted-resolver part of the plan;
it is recorded as future work rather than claimed as done.

Scope note: only remote account/SaaS/cloud service configs and stdio SaaS
adapters are in scope. Docs-only/search-only tools, local utilities, LSPs,
workflows, conditional/unresolved upstream entries, and hosted app-ID-only
mappings are excluded upstream by the fixture scope (counts are recorded in
the fixture headers for reconciliation).
