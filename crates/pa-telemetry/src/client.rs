//! The telemetry client: non-blocking `track`, background queue + batch flush.
//!
//! Contract: `track()` never blocks, never panics, and never fails the
//! agent. Events flow over an unbounded FIFO channel to a single background
//! task that owns a capped queue (drop-oldest) and flushes when a batch
//! fills, on the flush interval, or on explicit `flush()`/`shutdown()`. The
//! channel is FIFO, so everything `track`ed before a `flush` is included in
//! that flush without a drain step.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

use crate::event::TelemetryEvent;
use crate::properties::Properties;
use crate::sink::{SinkOutcome, TelemetrySink};

/// TS parity defaults: batch at 10 events, flush every 10s, queue cap 1024.
pub const DEFAULT_BATCH_SIZE: usize = 10;
pub const DEFAULT_FLUSH_INTERVAL: Duration = Duration::from_secs(10);
pub const DEFAULT_QUEUE_CAPACITY: usize = 1024;

/// Client configuration.
#[derive(Clone)]
pub struct TelemetryClientConfig {
    /// Pseudonymous installation id (sink-side identity, e.g. PostHog
    /// `distinct_id`). Load via [`crate::install_id`].
    pub install_id: String,
    /// Base properties merged under every event's own properties
    /// (version, os, execution mode...).
    pub base_properties: Properties,
    /// Flush when this many events are queued.
    pub batch_size: usize,
    /// Flush at least this often.
    pub flush_interval: Duration,
    /// In-memory queue cap; oldest events are dropped on overflow.
    pub queue_capacity: usize,
    /// Fan-out sinks: every sink receives every batch.
    pub sinks: Vec<Arc<dyn TelemetrySink>>,
}

impl TelemetryClientConfig {
    pub fn new(install_id: impl Into<String>) -> Self {
        Self {
            install_id: install_id.into(),
            base_properties: Properties::new(),
            batch_size: DEFAULT_BATCH_SIZE,
            flush_interval: DEFAULT_FLUSH_INTERVAL,
            queue_capacity: DEFAULT_QUEUE_CAPACITY,
            sinks: Vec::new(),
        }
    }
}

impl std::fmt::Debug for TelemetryClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelemetryClientConfig")
            .field("install_id", &self.install_id)
            .field("base_properties", &self.base_properties)
            .field("batch_size", &self.batch_size)
            .field("flush_interval", &self.flush_interval)
            .field("queue_capacity", &self.queue_capacity)
            .field("sinks", &self.sinks.len())
            .finish()
    }
}

/// The client handle. `Clone` shares one background worker.
#[derive(Clone)]
pub struct TelemetryClient {
    tx: mpsc::UnboundedSender<Cmd>,
    /// Events dropped because the queue overflowed or the worker was gone.
    dropped: Arc<AtomicU64>,
    /// Copy of the config base properties so `track` merges lock-free.
    base_properties: Properties,
    install_id: String,
}

enum Cmd {
    Track(TelemetryEvent),
    Flush(oneshot::Sender<()>),
    Shutdown(oneshot::Sender<()>),
}

impl TelemetryClient {
    /// A client that counts every track as dropped. Fallback for
    /// environments without a tokio runtime (telemetry must never fail the
    /// caller, and must never silently pretend events were sent).
    pub fn inert() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        drop(rx);
        Self {
            tx,
            dropped: Arc::new(AtomicU64::new(0)),
            base_properties: Properties::new(),
            install_id: "inert".to_string(),
        }
    }

    /// Spawn the background worker. Fails only if there is no tokio runtime
    /// on the current thread.
    pub fn spawn(config: TelemetryClientConfig) -> anyhow::Result<Self> {
        let (tx, rx) = mpsc::unbounded_channel();
        let dropped = Arc::new(AtomicU64::new(0));
        let base_properties = config.base_properties.clone();
        let install_id = config.install_id.clone();
        tokio::spawn(
            Worker {
                config,
                queue: VecDeque::new(),
                queue_dropped: Arc::clone(&dropped),
                rx,
            }
            .run(),
        );
        Ok(Self {
            tx,
            dropped,
            base_properties,
            install_id,
        })
    }

    /// Enqueue an event. The config base properties are merged under the
    /// event properties. Never blocks; if the worker is gone the event is
    /// dropped and counted.
    pub fn track(&self, name: impl Into<String>, properties: Properties) {
        let mut merged = self.base_properties.clone();
        merged.merge(&properties);
        let event = TelemetryEvent::new(name, merged);
        if self.tx.send(Cmd::Track(event)).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Drain and flush everything tracked so far. Returns when the batches
    /// have been handed to every sink (or dropped by their policy).
    pub async fn flush(&self) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Cmd::Flush(tx)).is_err() {
            return Ok(());
        }
        rx.await
            .map_err(|_| anyhow::anyhow!("telemetry worker stopped before flush"))
    }

    /// Flush once and stop the worker. Subsequent `track` calls are counted as
    /// dropped.
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Cmd::Shutdown(tx)).is_err() {
            return Ok(());
        }
        rx.await
            .map_err(|_| anyhow::anyhow!("telemetry worker stopped before shutdown"))
    }

    /// Events dropped so far (queue overflow / worker gone).
    pub fn dropped_count(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// The installation id this client reports as.
    pub fn install_id(&self) -> &str {
        &self.install_id
    }
}

/// Background worker: owns the queue, batching, interval, and sink fan-out.
struct Worker {
    config: TelemetryClientConfig,
    queue: VecDeque<TelemetryEvent>,
    queue_dropped: Arc<AtomicU64>,
    rx: mpsc::UnboundedReceiver<Cmd>,
}

impl Worker {
    async fn run(mut self) {
        let mut interval = tokio::time::interval(self.config.flush_interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first interval tick completes immediately; consume it before
        // the loop so a fresh worker cannot race an empty/unfilled flush
        // against the first enqueued events.
        interval.tick().await;
        loop {
            tokio::select! {
                cmd = self.rx.recv() => {
                    let Some(cmd) = cmd else { break };
                    match cmd {
                        Cmd::Track(event) => {
                            self.enqueue(event);
                            if self.queue.len() >= self.config.batch_size {
                                self.flush_now().await;
                            }
                        }
                        Cmd::Flush(tx) => {
                            self.flush_now().await;
                            let _ = tx.send(());
                        }
                        Cmd::Shutdown(tx) => {
                            self.flush_now().await;
                            let _ = tx.send(());
                            break;
                        }
                    }
                }
                _ = interval.tick() => {
                    self.flush_now().await;
                }
            }
        }
    }

    fn enqueue(&mut self, event: TelemetryEvent) {
        if self.queue.len() >= self.config.queue_capacity {
            self.queue.pop_front();
            self.queue_dropped.fetch_add(1, Ordering::Relaxed);
        }
        self.queue.push_back(event);
    }

    async fn flush_now(&mut self) {
        while !self.queue.is_empty() {
            let take = self.queue.len().min(self.config.batch_size);
            let events: Vec<TelemetryEvent> = self.queue.drain(..take).collect();
            for sink in &self.config.sinks {
                let outcome = sink
                    .send_batch(&self.config.install_id, events.clone())
                    .await;
                if outcome == SinkOutcome::Dropped {
                    tracing::debug!(count = events.len(), "telemetry batch dropped by sink");
                }
            }
        }
    }
}
