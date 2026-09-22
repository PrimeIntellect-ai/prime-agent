//! The opt-out fast-path sink: consumes batches without emitting anything.

use std::pin::Pin;

use crate::event::TelemetryEvent;
use crate::sink::{SinkOutcome, TelemetrySink};

/// Consumes every batch without side effects. Used when telemetry is disabled
/// so callers keep a uniform [`crate::TelemetryClient`] surface.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopSink;

impl TelemetrySink for NoopSink {
    fn send_batch<'a>(
        &'a self,
        _install_id: &'a str,
        _events: Vec<TelemetryEvent>,
    ) -> Pin<Box<dyn std::future::Future<Output = SinkOutcome> + Send + 'a>> {
        Box::pin(std::future::ready(SinkOutcome::Sent))
    }
}
