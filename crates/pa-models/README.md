# pa-models

The live model catalog subsystem: fetch layer, no-cold-start chain, strict
schemas, transport pinning, and the credentialed Prime Inference catalog.
Port of the TS catalog client (branch `feat/catalog-client`:
`model-catalog-cache.ts`, `model-catalog.ts`, `model-compat-schema.ts`,
`provider-model-catalog.ts`, `bundled-model-catalog.ts`,
`prime-inference-model-catalog.ts`).

## Scope

- Fetch layer: unauthenticated GET on the two catalog URLs; 5 s timeout,
  8 MiB cap (content-length AND streaming), redirects refused, ETag
  `If-None-Match` with 304 snapshot reuse; `PI_OFFLINE` disables the network.
- No-cold-start chain: validated last-good disk cache -> build-time bundled
  snapshot -> compiled fallback (42 transport tuples + 110 offline Prime
  Inference entries).
- Strict schemas: serde `deny_unknown_fields`, version gates (models
  `schemaVersion == 1`), skip-invalid for remote model refresh, compat
  validation per `api`. Unsupported future versions keep last-good
  silently, forever.
- Transport pinning: every remote model must match a compiled
  `(provider, api, baseUrl)` tuple; catalog data never carries request
  headers.
- Prime Inference: live credentialed fetch, scope-keyed disk cache
  (HMAC-SHA256 of key over team), 401/403 clears only that scope.
- Refresh: hourly + startup + picker open + auth change; fire-and-forget;
  coalesced per source; a mid-session refresh never retargets the active
  model.

## Non-goals

- The plugins/MCP catalog serde + resolution (the plugins lane; this crate
  hands it the fetcher, the generic `CatalogCache`, and the bundled asset
  bytes).
- The build-time asset generator + release packer (the build lane).
- Session auth storage, `models.json` parsing, and registry merges
  (`pa-core`): the user's local `models.json` takes precedence over this
  catalog and is merged by its owner.
- The catalog repo's sync/export tooling (lives with the data).

## Public API

- `ModelCatalog` (chain resolution + refresh cadence),
  `RefreshTrigger`, `PrimeCredentials`
- `cache::CatalogCache<T>` (generic last-good cache; the plugins lane
  instantiates it with its own fail-closed parser),
  `cache::{RefreshOptions, PUBLIC_SCOPE}`
- `fetch::{CatalogFetcher, FetchOutcome, FetchError, MODEL_CATALOG_URL,
  MCP_SERVICE_CATALOG_URL}`
- `schema::{parse_model_catalog, InvalidEntries, ModelCatalogV1}`
- `compat::is_model_compat`
- `pinning::{parse_provider_model_catalog, pin_catalog_models, PinnedTemplates}`
- `transports::{compiled_models, compiled_transport_tuples,
  prime_inference_offline_entries}`
- `bundled::{BundledAssets, load_bundled_models, PACKAGED_MODEL_CATALOG_FILE,
  PACKAGED_MCP_CATALOG_FILE}`
- `prime_inference::{PrimeInferenceCatalog, PrimeInferenceCredentials,
  build_prime_inference_models, merge_prime_inference_models,
  parse_prime_inference_model_catalog, is_private_prime_inference_model_id,
  scope_key, PRIME_INFERENCE_BASE_URL}`
- `offline::is_catalog_offline`

## Dependencies (direction compliance)

Depends on `pa-ai` (compiled transport templates: `models_generated`) and
`pa-types` (shared `Model`). Nothing else in the workspace; no crate below
`pa-ai` is touched. Consumers live at or above `pa-agent` (registry wiring
in `pa-core`). The plugins lane must not place its catalog code in `pa-ai`
(pa-models already depends on it).
