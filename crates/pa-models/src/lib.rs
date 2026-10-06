//! Live model catalog subsystem for Prime Agent.
//! Everything the catalog can do is select among transports the client
//! compiled in; it can never introduce a transport or change what a
//! request sends. Depends on pa-ai and pa-types; nothing above pa-agent.

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

pub use chain::{ModelCatalog, PrimeCredentials, RefreshTrigger};
pub use pa_types::ai::Model;

pub const CATALOG_REFRESH_INTERVAL_MS: u64 = 60 * 60_000;
