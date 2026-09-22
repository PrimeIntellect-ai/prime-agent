//! Sinks shipped with the crate.

pub mod file;
pub mod mock;
pub mod noop;
pub mod posthog;

pub use file::FileSink;
pub use mock::{MockSink, RecordedBatch};
pub use noop::NoopSink;
pub use posthog::{PostHogEndpoint, PostHogSink};
