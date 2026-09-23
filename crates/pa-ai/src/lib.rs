//! Provider APIs and model registry for Prime Agent.
//!
//! Rust port of the TypeScript `packages/ai` reference implementation. The
//! wire/domain types live in `pa-types` and are re-exported from [`types`];
//! everything else here is provider machinery.
//!
//! ## Ownership
//! One owned area: providers, model registry, streaming. `pa-types` is the only
//! dependency (one-way). Per-provider internals are `pub(crate)`; the public
//! surface is the streaming facade ([`stream`]/[`complete`]/[`stream_simple`]/
//! [`complete_simple`]), the [`Provider`] trait and [`ProviderRegistry`], the
//! faux provider for tests/tooling, model helpers, env-key resolution, and the
//! overflow / stream-failure / JSON-repair utilities consumed by the agent
//! layer.
//!
//! Wire-shape enums mirror the TS tagged unions 1:1, so `large_enum_variant`
//! and `result_large_err` are allowed crate-wide rather than boxing payloads.
#![allow(clippy::large_enum_variant, clippy::result_large_err)]

pub mod env_api_keys;
pub mod models;
pub mod models_generated;
pub mod registry;
pub mod types;

mod event_stream;
mod providers;
mod stream;

#[cfg(test)]
mod prime_inference_differential_test;

pub use event_stream::{AssistantMessageEventExt, AssistantMessageEventStream};
pub use providers::faux;

/// Codex WebSocket session debugging and cleanup surface
/// (`getOpenAICodexWebSocketDebugStats`,
/// `resetOpenAICodexWebSocketDebugStats`,
/// `closeOpenAICodexWebSocketSessions` in the TS reference).
pub mod codex_debug {
    pub use crate::providers::openai_codex_responses::session::{
        close_websocket_sessions, get_debug_stats as get_websocket_debug_stats,
        reset_debug_stats as reset_websocket_debug_stats, WebSocketDebugStats,
    };
}
pub use providers::simple_options::{default_request_max_tokens, effective_request_max_tokens};
pub use registry::{Provider, ProviderRegistry};
pub use stream::{complete, complete_simple, stream, stream_simple};

// Cross-crate surface consumed by the agent layer (pa-ai owned).
pub mod utils {
    //! Overflow detection, stream-failure classification, JSON repair parsing,
    //! and structured diagnostics — the parts of the TS `utils/` the agent
    //! layer calls. SSE decoding, HTTP plumbing, hashing, and logging are
    //! crate-internal.
    pub use crate::utils_inner::diagnostics;
    pub use crate::utils_inner::json_parse;
    pub use crate::utils_inner::overflow;
    pub use crate::utils_inner::stream_failure;
}
mod utils_inner;

pub use utils::json_parse::{parse_json_with_repair, parse_partial_json, parse_streaming_json};
pub use utils::overflow::is_context_overflow;
pub use utils::stream_failure::{
    classify_stream_failure, format_stream_failure_message, stream_failure_from_stop_reason,
    ProviderError, StreamFailureError, StreamFailureInfo, StreamFailureKind,
};
mod cache_pricing;
pub use cache_pricing::{
    get_anthropic_cache_costs, get_anthropic_cache_write_cost,
    has_standard_anthropic_cache_pricing, AnthropicCacheCreationUsage,
};
