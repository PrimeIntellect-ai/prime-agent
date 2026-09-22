//! Live model catalog subsystem for Prime Agent.
//!
//! Port of the TS catalog client (branch `feat/catalog-client`):
//! - `packages/coding-agent/src/core/model-catalog-cache.ts` (fetch + cache
//!   + hourly refresh coalescing) -> [`cache`] + [`fetch`]
//! - `packages/ai/src/model-catalog.ts` (strict model catalog schema) ->
//!   [`schema`]
//! - `packages/ai/src/model-compat-schema.ts` -> [`compat`]
//! - `packages/coding-agent/src/core/provider-model-catalog.ts` (transport
//!   pinning) -> [`pinning`]
//! - `packages/coding-agent/src/core/bundled-model-catalog.ts` -> [`bundled`]
//! - `packages/coding-agent/src/core/prime-inference-model-catalog.ts` +
//!   `packages/ai/src/prime-inference-model-catalog.ts` -> [`prime_inference`]
//!
//! The two fetched files are the client-facing catalog contract
//! (`models/catalog.v1.json` + `plugins/catalog.v2.json` of the catalog
//! repo). Everything the catalog can do is select among transports the
//! client compiled in; it can never introduce a transport or change what a
//! request sends.
//!
//! Ownership: pa-models depends on pa-ai (compiled transport templates) and
//! pa-types (shared `Model`). Nothing above pa-agent may be depended on.

pub mod bundled;
pub mod cache;
pub mod compat;
pub mod fetch;
pub mod offline;
pub mod pinning;
pub mod prime_inference;
pub mod schema;
pub mod transports;

mod chain;

pub use chain::{ModelCatalog, RefreshTrigger};
pub use pa_types::ai::Model;

/// Refresh cadence: every [`CATALOG_REFRESH_INTERVAL_MS`] milliseconds
/// (`CATALOG_REFRESH_INTERVAL_MS` in the TS reference).
pub const CATALOG_REFRESH_INTERVAL_MS: u64 = 60 * 60_000;
