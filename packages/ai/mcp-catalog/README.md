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
- stdio SaaS adapters (the Claude catalog's 32) are recorded in the pinned
  fixtures with their commands; since the 2026-09-15 final cut none of them
  ships (see below). A legacy SSE transport is recorded and flagged the same
  way — it ships only when it collects a user token/key.
- Zero-app shipping policy (2026-09-14 product decision): Prime maintains ZERO
  provider OAuth apps, so the catalog ships only self-serve connectors —
  dynamic client registration (readiness `oauth-ready`) or user-supplied
  tokens/keys (`user-setup`). The 16 providers that require a
  provider-registered OAuth client (Figma, Slack, Gmail, Google Calendar,
  Google Drive, MongoDB Atlas) or whose self-serve path stayed honestly
  unknown (Shopify, HubSpot, LogRocket, Mapbox Docs, Adobe for Creativity,
  Spotify Confidence, SumUp, Synthflow) are excluded via the documented
  `excludedServers` list — one entry per upstream record, each with a
  per-entry reason citing the decision — and the importer refuses to emit a
  `prime-restricted` or `unknown` entry at all, so an unverified provider can
  never ship silently. The pinned source snapshots and the audit evidence for
  excluded endpoints stay committed as history.
- Final catalog cut (2026-09-15 product decision: the catalog ships one-click
  DCR or user token/key only): beyond the zero-app classes, a `user-setup`
  entry ships only when its requirement is token/key-shaped — bearer-token /
  api-key credentials, a tenant config carrying a genuine non-url field (a
  token or per-instance value), or a legacy-transport entry that still
  collects a token/key. The 49 entries that are not (the 14
  registered-client entries whose authorization servers accept only
  secret-bearing client auth — Airwallex, Atlan, GitLab, Hugging Face,
  LegalZoom, Lusha, Miro, monday.com, PlanetScale, Supabase, Vercel,
  Windsor.ai, ZoomInfo and the Airwallex sandbox; the 32 local-runtime
  stdio adapters; and the 3 url-only tenant templates — ActiveCampaign,
  JFrog, Pigment) are excluded via the documented `excludedServers` list —
  one entry per upstream record (64 keys), each with a per-entry reason
  citing the decision and the specific evidence — and the importer refuses
  to emit any other requirement shape, so a registered-client demotion, a
  local-runtime adapter or a url-only template can never silently re-derive
  into the catalog. The demotion/auth-methods honesty machinery that derives
  these requirements stays active for the survivors; the pinned source
  snapshots and audit evidence stay committed as history.
- Everything except the pre-existing `linear`/`notion` integrations ships
  `verification: "unverified"`. Import success is never a readiness claim.

The committed `catalog.json` must always equal the importer output; the
regression test in `packages/ai/test/mcp-catalog.test.ts` rebuilds it from
these fixtures and fails on drift.

## Read-only public metadata audit

`audit/metadata-audit.json` is a committed, reproducible snapshot of public
OAuth metadata for the remote endpoints (102 http + 1 sse at capture time,
including the endpoints later removed by the 2026-09-14 zero-app cut and the
2026-09-15 final cut — the excluded endpoints' results stay committed as
evidence), captured by
`audit/audit-provider-metadata.ts`. Re-runs audit the current catalog target
set and retire, never delete, registration-attempt evidence for servers that
left it:

- public unauthenticated GETs only — no Authorization headers, no cookies, no
  registration POSTs, no OAuth or browser flows, no MCP tool calls, no stored
  credentials, no writes; redirects are recorded, never followed;
- bounded per request (10s timeout, 256 KiB body, global concurrency 6) and
  issued through an undici dispatcher whose DNS lookup validates that every
  resolved address is public and returns only those validated addresses for the
  connection (no re-resolution race; TLS hostname validation retained);
- every fetched URL — including metadata-supplied destinations — must be https
  with a literal public address;
- all RFC 9728 locations are probed per endpoint (WWW-Authenticate
  `resource_metadata` pointer, pathful and origin-level well-known), so
  providers that serve different bodies per location (Notion, Slack) keep raw
  evidence of which document serves where;
- the engine selection is mirrored exactly: a `resource_metadata` pointer is
  followed alone and any failure fails closed (no well-known fall-through);
  absent a pointer the pathful well-known is tried, then the origin-level root
  location (SDK parity — a 4xx at one location is not proof the other is
  absent); a candidate is selectable only when its document matches the
  endpoint audience under the engine's component comparison and carries
  authorization servers, mirroring the engine's own validation. Fail-closed
  states carry an honest `selectionNote` (pointer failure, served-but-invalid
  document, non-4xx/non-JSON well-known response). The all-4xx state is NOT a
  failure: the engine falls back to origin-level authorization-server
  discovery there, so no note is recorded and the captured AS evidence
  (issuer = endpoint origin, mirroring the same fallback) decides readiness.
- `authorizationServer.registrationAttempt` blocks are the one sanctioned
  supplement to the GET-derived results: live registration evidence recorded
  from real engine login attempts — the audit script itself never POSTs
  registration endpoints — each carrying explicit provenance and preserved
  verbatim across re-runs (Figma: its advertised DCR endpoint returned HTTP
  403 to the engine's anonymous registration during dogfooding, 2026-09-13).
  Blocks for servers that later left the audit target set — e.g. Figma after
  the zero-app catalog cut — are carried forward verbatim in the top-level
  `retiredRegistrationAttempts` array, so live evidence is history and a
  re-run can never silently drop it.

The importer merges this evidence into `catalog.json` offline and
deterministically:

- `auth.metadata` is observational evidence only (status, issuer/resource,
  PKCE, DCR/CIMD flags, PRM and AS scope lists, token auth methods, source
  URLs, capture date). It is never a live credential authority and never a
  Connect gate. Omitted fields mean "not advertised", never "unsupported";
  an explicit `dynamicClientRegistration: false` means the endpoint IS
  advertised but its live anonymous registration was rejected (gated), so the
  engine's standard no-credentials flow fails. `tokenAuthMethods` is
  ENGINE-COMPATIBILITY evidence: classification runs the engine's own shared
  client-auth decision (`decideClientAuthMethod` in `packages/ai/src/mcp/oauth.ts`)
  over the captured list, so the shipped readiness can never diverge from the
  connect-time gate.
- `setup.readiness` (`oauth-ready` / `user-setup` / `prime-restricted` /
  `unknown`) is informational-only; `setup.status` stays the only hard lever.
  `oauth-ready` requires the engine's audience rule (component comparison:
  exact canonical endpoint or exact origin, root-slash normalized) plus
  dynamic-client-registration evidence — a CIMD flag alone is never sufficient
  (no Prime-controlled identity document is deployed) — plus the engine's
  client-auth compatibility gate: the standard no-credentials flow logs in as
  a PUBLIC client, so the captured token auth methods must include `none` or
  be omitted (the engine applies the public-client spec default). A coherent
  DCR entry whose authorization server advertises ONLY secret-bearing methods
  (live evidence: Hugging Face — `client_secret_basic`, `client_secret_post`)
  fails the engine's gate at connect time and demotes honestly to the
  `user-setup` OAuth path with client-id/client-secret setup fields
  (`requirement: registered-client`, reason "requires your own OAuth app"):
  the user registers their OWN app with the provider, which is zero-app
  compliant self-serve — a demotion, never an exclusion. Entries whose
  advertised methods serve not even a configured secret-bearing client (e.g.
  mTLS-only) stay honestly `unknown`. A served document that fails the
  engine's audience or structure validation fails closed (no origin-AS
  fallback) and keeps the entry honestly `unknown` with the fail-closed reason
  in the metadata note; an endpoint with no valid protected-resource document
  anywhere follows the engine's origin-level authorization-server fallback, so
  captured AS evidence still decides. An advertised registration endpoint
  whose live anonymous registration was rejected (gated DCR, e.g. Figma's
  HTTP 403) can never be `oauth-ready`: the entry classifies like DCR-less
  providers. Since the 2026-09-14 zero-app cut the `prime-restricted` and
  `unknown` classes do not ship at all — the importer refuses to emit them,
  and providers that classify there are excluded with documented reasons
  instead (Figma was the live gated-DCR case: pre-registered,
  `registered-client`, then cut; its live evidence stays in the audit store).
- Placeholder/branded-client-only blockers were cleared with evidence where
  the provider supports self-serve OAuth (Airtable stays Connect-attemptable);
  genuine documented requirements stay hard for kept providers — API
  keys/bearer tokens (GitHub PAT, Zoom, Render, datadog…), token-bearing
  tenant config (Dynatrace, Sourcegraph) and per-instance values (CockroachDB
  cluster id), and the legacy-transport sandbox entry that still collects a
  token (PayPal Sandbox). Provider-client requirements (Google, Slack,
  MongoDB), honest unknowns (Shopify, HubSpot, LogRocket, …), the
  user-own-app OAuth path (GitLab, Miro, Supabase, …), local-runtime stdio
  adapters and url-only tenant templates no longer ship: the 2026-09-14
  zero-app cut and the 2026-09-15 final cut excluded those providers with
  per-entry reasons.
- `auth.alternatives` records documented per-path alternatives with their own
  readiness (Airtable PAT, GitHub standard OAuth, Render partner OAuth).
- Ready entries are never downgraded by unavailable audit evidence, and
  unknown is never treated as proof of a restriction.

Local user sources cannot self-assert any of this: `setup.readiness`,
`auth.alternatives` and `auth.metadata` are Prime audit assessments and are
rejected from local files with visible errors (`setup.requirement` stays
allowed as honest self-description of the user's own service).

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
