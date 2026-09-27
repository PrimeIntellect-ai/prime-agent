//! The sink contract: where event batches go.

use std::future::Future;
use std::pin::Pin;

use crate::event::TelemetryEvent;

/// Outcome of one batch attempt against one sink.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkOutcome {
    /// The sink consumed the batch.
    Sent,
    /// Best-effort failure (offline, timeout, IO error). The batch is
    /// dropped; telemetry must never retry-storm or fail the agent.
    Dropped,
}

/// Destination for telemetry batches. Implementations MUST be best-effort:
/// they never panic, never block long (their own timeout applies), and report
/// [`SinkOutcome::Dropped`] instead of propagating errors upward.
///
/// The batch future is boxed (not a native RPITIT) because the client stores
/// sinks as `Vec<Arc<dyn TelemetrySink>>` for fan-out; RPITIT methods are
/// not dyn-compatible. The `+ Send` bound is explicit and the lifetime ties
/// the future to the sink borrow, so implementations can borrow `&self`.
///
/// `install_id` is the pseudonymous installation id used as the sink-side
/// identity (`PostHog` `distinct_id`).
pub trait TelemetrySink: Send + Sync {
    /// Send one batch. Called serially by the telemetry worker, so at most one
    /// `send_batch` future per sink is in flight at a time.
    fn send_batch<'a>(
        &'a self,
        install_id: &'a str,
        events: Vec<TelemetryEvent>,
    ) -> Pin<Box<dyn Future<Output = SinkOutcome> + Send + 'a>>;
}
