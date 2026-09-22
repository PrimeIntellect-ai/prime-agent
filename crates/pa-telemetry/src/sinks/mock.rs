//! Test fixture sink: records every batch for inspection.

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

use crate::event::TelemetryEvent;
use crate::sink::{SinkOutcome, TelemetrySink};

/// A batch as delivered to a sink.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordedBatch {
    pub install_id: String,
    pub events: Vec<TelemetryEvent>,
}

/// Records all batches in memory; used by unit tests here and in downstream
/// crate tests. Never drops by itself, but `fail_batches` flips the outcome to
/// exercise the client's drop policy.
#[derive(Debug, Default)]
pub struct MockSink {
    batches: Mutex<Vec<RecordedBatch>>,
    fail_batches: bool,
}

impl MockSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Report every batch as dropped (failure-injection for drop-policy tests).
    pub fn failing() -> Self {
        Self {
            batches: Mutex::new(Vec::new()),
            fail_batches: true,
        }
    }

    /// All recorded batches.
    pub fn batches(&self) -> Vec<RecordedBatch> {
        self.batches.lock().expect("mock sink poisoned").clone()
    }

    /// All recorded events across batches, in order.
    pub fn events(&self) -> Vec<TelemetryEvent> {
        self.batches()
            .into_iter()
            .flat_map(|batch| batch.events)
            .collect()
    }

    /// Recorded event names, in order.
    pub fn event_names(&self) -> Vec<String> {
        self.events().into_iter().map(|event| event.name).collect()
    }

    /// Clear recorded batches.
    pub fn clear(&self) {
        self.batches.lock().expect("mock sink poisoned").clear();
    }
}

impl TelemetrySink for MockSink {
    fn send_batch<'a>(
        &'a self,
        install_id: &'a str,
        events: Vec<TelemetryEvent>,
    ) -> Pin<Box<dyn Future<Output = SinkOutcome> + Send + '_>> {
        let outcome = if self.fail_batches {
            SinkOutcome::Dropped
        } else {
            self.batches
                .lock()
                .expect("mock sink poisoned")
                .push(RecordedBatch {
                    install_id: install_id.to_string(),
                    events,
                });
            SinkOutcome::Sent
        };
        Box::pin(std::future::ready(outcome))
    }
}
