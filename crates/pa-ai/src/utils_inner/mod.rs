//! Shared provider utilities: diagnostics, stream failures, overflow, JSON
//! tolerance, SSE decoding, HTTP plumbing, and logging.

pub mod diagnostics;
pub mod h2_classify;
pub mod hash;
pub mod headers;
pub mod http;
pub mod json_parse;
pub mod log;
pub mod overflow;
pub mod sanitize_unicode;
pub mod sse;
pub mod stream_failure;

pub use stream_failure::ProviderError;
