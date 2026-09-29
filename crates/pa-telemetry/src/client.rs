//! The telemetry client: non-blocking `track`, background queue + batch flush.
//!
//! Contract: `track()` never blocks, never panics, and never fails the
//! agent. Events flow over an unbounded FIFO channel to a single background
//! task that owns the delivery state and flushes when a batch fills, on the
//! flush interval, or on explicit `flush()`/`shutdown()`.
//!
//! The #2117 delivery contract: each sink is an independent delivery
//! channel with its own in-memory queue (cap [`DEFAULT_QUEUE_CAPACITY`],
//! drop-oldest on overflow); batches cap at
//! [`DEFAULT_BATCH_SIZE`] events and [`DEFAULT_MAX_BATCH_BYTES`] bytes;
//! a dropped batch requeues with bounded attempts
//! ([`RetryPolicy::max_attempts`]) and a capped backoff
//! (`min(max_backoff, flush_interval * 2^attempts)`, never longer than
//! [`RetryPolicy::max_backoff`]); entries expire after
//! [`MAX_AGE`] or the attempt cap and count as dropped. Per-channel
//! queues mean a retried batch never re-delivers to a sink that already
//! accepted it (no mirror duplicates), and `shutdown()` never waits on a
//! backoff: it drains once, best-effort, and stops.
//!
//! Before any sink sees a batch, every event is normalized through
//! [`crate::catalog::sanitize`] (the platform adjust layer: unknown keys
//! drop, out-of-vocabulary enums fall back, numbers clamp).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};

use crate::catalog::sanitize;
use crate::event::TelemetryEvent;
use crate::properties::Properties;
use crate::sink::{SinkOutcome, TelemetrySink};

/// TS/#2117 parity defaults: batches cap at 20 events, flush every 10s,
/// queue cap 256 per sink.
pub const DEFAULT_BATCH_SIZE: usize = 20;
pub const DEFAULT_FLUSH_INTERVAL: Duration = Duration::from_secs(10);
pub const DEFAULT_QUEUE_CAPACITY: usize = 256;
/// The #2117 batch byte cap (the wire body estimate).
pub const DEFAULT_MAX_BATCH_BYTES: usize = 30_000;
/// The #2117 retention: entries older than 24h expire on the next flush.
pub const MAX_AGE: Duration = Duration::from_hours(24);

/// The bounded delivery retry policy (#2117: five attempts, backoff capped
/// at 60 seconds).
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    /// Total send attempts per entry before it expires (1 = no retry).
    pub max_attempts: u32,
    /// The backoff cap: `min(max_backoff, flush_interval * 2^attempts)`.
    pub max_backoff: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            max_backoff: Duration::from_secs(60),
        }
    }
}

/// One queued event per sink channel.
struct QueueEntry {
    event: TelemetryEvent,
    attempts: u32,
}

/// One sink's delivery channel: its own bounded queue and backoff state.
struct Channel {
    sink: Arc<dyn TelemetrySink>,
    queue: VecDeque<QueueEntry>,
    /// When the next retry may run (`None` = no failed batch waiting).
    next_retry_at: Option<tokio::time::Instant>,
}

/// Client configuration.
#[derive(Clone)]
pub struct TelemetryClientConfig {
    /// Pseudonymous installation id (sink-side identity, e.g. `PostHog`
    /// `distinct_id`). Load via [`crate::install_id`].
    pub install_id: String,
    /// Base properties merged under every event's own properties
    /// (version, os, execution mode...).
    pub base_properties: Properties,
    /// Flush when this many events are queued.
    pub batch_size: usize,
    /// Flush at least this often.
    pub flush_interval: Duration,
    /// In-memory queue cap per sink; oldest events drop on overflow.
    pub queue_capacity: usize,
    /// The batch byte cap (wire-body estimate).
    pub max_batch_bytes: usize,
    /// The bounded retry policy.
    pub retry: RetryPolicy,
    /// Fan-out sinks: every sink receives every event.
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
            max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
            retry: RetryPolicy::default(),
            sinks: Vec::new(),
        }
    }
}

// The sink handles and retry policy are opaque services without a
// Debug surface; the config rows above are the debug surface.
#[allow(clippy::missing_fields_in_debug)]
impl std::fmt::Debug for TelemetryClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelemetryClientConfig")
            .field("install_id", &self.install_id)
            .field("base_properties", &self.base_properties)
            .field("batch_size", &self.batch_size)
            .field("flush_interval", &self.flush_interval)
            .field("queue_capacity", &self.queue_capacity)
            .field("max_batch_bytes", &self.max_batch_bytes)
            .field("sinks", &self.sinks.len())
            .finish()
    }
}

/// The client handle. `Clone` shares one background worker.
#[derive(Clone)]
pub struct TelemetryClient {
    tx: mpsc::UnboundedSender<Cmd>,
    /// Events dropped because a channel queue overflowed, a worker was
    /// gone, or an entry expired (attempt cap / age).
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
    #[must_use]
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

    /// Spawn the background worker.
    ///
    /// # Errors
    ///
    /// Returns an error only when there is no tokio runtime on the current
    /// thread (the caller falls back to the inert client).
    pub fn spawn(mut config: TelemetryClientConfig) -> anyhow::Result<Self> {
        let (tx, rx) = mpsc::unbounded_channel();
        let dropped = Arc::new(AtomicU64::new(0));
        let base_properties = config.base_properties.clone();
        let install_id = config.install_id.clone();
        let sinks = std::mem::take(&mut config.sinks);
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|error| anyhow::anyhow!("no tokio runtime on this thread: {error}"))?;
        runtime.spawn(
            Worker {
                channels: sinks
                    .into_iter()
                    .map(|sink| Channel {
                        sink,
                        queue: VecDeque::new(),
                        next_retry_at: None,
                    })
                    .collect(),
                config,
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
    // Workspace API consumed across crates (pa-cli, pa-core); the by-value
    // `Properties` signature is fleet-wide, out of this lane's scope.
    #[allow(clippy::needless_pass_by_value)]
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
    ///
    /// # Errors
    ///
    /// Returns an error when the worker stopped before the flush finished
    /// (a dropped client handle mid-shutdown).
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
    ///
    /// # Errors
    ///
    /// Returns an error when the worker stopped before the shutdown
    /// handshake completed.
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Cmd::Shutdown(tx)).is_err() {
            return Ok(());
        }
        rx.await
            .map_err(|_| anyhow::anyhow!("telemetry worker stopped before shutdown"))
    }

    /// Events dropped so far (queue overflow / worker gone / expiry).
    #[must_use]
    pub fn dropped_count(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// The installation id this client reports as.
    #[must_use]
    pub fn install_id(&self) -> &str {
        &self.install_id
    }
}

/// Background worker: owns the per-sink channels, batching, interval, and
/// sink fan-out.
struct Worker {
    channels: Vec<Channel>,
    config: TelemetryClientConfig,
    queue_dropped: Arc<AtomicU64>,
    rx: mpsc::UnboundedReceiver<Cmd>,
}

impl Worker {
    async fn run(mut self) {
        let mut next_deadline = tokio::time::Instant::now() + self.config.flush_interval;
        loop {
            tokio::select! {
                cmd = self.rx.recv() => {
                    let Some(cmd) = cmd else {
                        // Every client handle is gone: one final best-effort
                        // drain so a one-shot client's events are never
                        // lost to the drop (no missed fires).
                        self.flush_final().await;
                        break;
                    };
                    match cmd {
                        Cmd::Track(event) => {
                            self.enqueue(&event);
                            if self.channels.iter().any(|channel| {
                                channel.queue.len() >= self.config.batch_size
                                    && channel.ready_for_send(tokio::time::Instant::now())
                            }) {
                                self.flush_pass().await;
                                next_deadline = self.next_deadline();
                            }
                        }
                        Cmd::Flush(tx) => {
                            self.flush_pass().await;
                            let _ = tx.send(());
                            next_deadline = self.next_deadline();
                        }
                        Cmd::Shutdown(tx) => {
                            // The final drain never waits on a backoff and
                            // never retries: bounded shutdown, best effort.
                            self.flush_final().await;
                            let _ = tx.send(());
                            break;
                        }
                    }
                }
                () = tokio::time::sleep_until(next_deadline) => {
                    self.flush_pass().await;
                    next_deadline = self.next_deadline();
                }
            }
        }
    }

    /// The next flush deadline: the base interval, stretched by the
    /// largest pending retry backoff (`min(max_backoff, interval *
    /// 2^attempts)`), so a failing channel never request-storms.
    fn next_deadline(&self) -> tokio::time::Instant {
        let now = tokio::time::Instant::now();
        let max_attempts = self
            .channels
            .iter()
            .flat_map(|channel| channel.queue.iter().map(|entry| entry.attempts))
            .max()
            .unwrap_or(0);
        let mut delay = self.config.flush_interval;
        if max_attempts > 0 {
            let backoff = self
                .config
                .flush_interval
                .saturating_mul(1 << max_attempts.min(16));
            delay = delay.max(backoff.min(self.config.retry.max_backoff));
        }
        now + delay
    }

    fn enqueue(&mut self, event: &TelemetryEvent) {
        for channel in &mut self.channels {
            if channel.queue.len() >= self.config.queue_capacity {
                channel.queue.pop_front();
                self.queue_dropped.fetch_add(1, Ordering::Relaxed);
            }
            channel.queue.push_back(QueueEntry {
                event: event.clone(),
                attempts: 0,
            });
        }
    }

    /// One delivery pass over every channel: expire, batch, send, retry.
    async fn flush_pass(&mut self) {
        let now = std::time::SystemTime::now();
        let now_epoch_ms = now
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as u64);
        for channel in &mut self.channels {
            channel.expire(
                now_epoch_ms,
                self.config.retry.max_attempts,
                &self.queue_dropped,
            );
            if !channel.ready_for_send(tokio::time::Instant::now()) {
                continue;
            }
            channel.next_retry_at = None;
            let mut retry_after: Option<u32> = None;
            while !channel.queue.is_empty() {
                // The batch take: up to `batch_size` events within the byte
                // budget (a single over-budget event still ships - there is
                // nothing to split).
                let mut take = 0usize;
                let mut bytes = 0usize;
                for entry in channel.queue.iter().take(self.config.batch_size) {
                    let size = entry.event.wire_size_estimate();
                    if take > 0 && bytes + size > self.config.max_batch_bytes {
                        break;
                    }
                    bytes += size;
                    take += 1;
                }
                let mut entries: Vec<QueueEntry> = Vec::with_capacity(take);
                for _ in 0..take {
                    if let Some(entry) = channel.queue.pop_front() {
                        entries.push(entry);
                    }
                }
                let mut events: Vec<TelemetryEvent> =
                    entries.iter().map(|entry| entry.event.clone()).collect();
                for event in &mut events {
                    sanitize(&event.name, &mut event.properties);
                }
                let outcome = channel
                    .sink
                    .send_batch(&self.config.install_id, events)
                    .await;
                match outcome {
                    SinkOutcome::Sent => {}
                    SinkOutcome::Dropped => {
                        // Requeue (front, in order) with attempts+1; the
                        // attempt cap expires the entries on a later pass.
                        let max_attempts_after = entries
                            .iter()
                            .map(|entry| entry.attempts + 1)
                            .max()
                            .unwrap_or(1);
                        for entry in entries.into_iter().rev() {
                            channel.queue.push_front(QueueEntry {
                                event: entry.event,
                                attempts: entry.attempts + 1,
                            });
                        }
                        retry_after = Some(max_attempts_after);
                        break;
                    }
                }
            }
            if let Some(attempts) = retry_after {
                channel.next_retry_at =
                    Some(tokio::time::Instant::now() + self.config.retry_backoff(attempts));
            }
        }
    }

    /// The shutdown drain: every channel, one pass, no retry bookkeeping
    /// (bounded shutdown; a hard exit may lose reports, like the TS
    /// contract).
    async fn flush_final(&mut self) {
        for channel in &mut self.channels {
            while !channel.queue.is_empty() {
                // The final drain honors the same batch byte cap as the
                // interval path: a shutdown batch never exceeds what the
                // delivery contract allows.
                let mut take = 0usize;
                let mut bytes = 0usize;
                for entry in channel.queue.iter().take(self.config.batch_size) {
                    let size = entry.event.wire_size_estimate();
                    if take > 0 && bytes + size > self.config.max_batch_bytes {
                        break;
                    }
                    bytes += size;
                    take += 1;
                }
                let mut events: Vec<TelemetryEvent> = Vec::with_capacity(take);
                for _ in 0..take {
                    if let Some(entry) = channel.queue.pop_front() {
                        events.push(entry.event);
                    }
                }
                for event in &mut events {
                    sanitize(&event.name, &mut event.properties);
                }
                let _ = channel
                    .sink
                    .send_batch(&self.config.install_id, events)
                    .await;
            }
        }
    }
}

impl Channel {
    /// True when the channel may send now (`next_retry_at` passed or no
    /// failed batch waiting).
    fn ready_for_send(&self, now: tokio::time::Instant) -> bool {
        self.next_retry_at.is_none_or(|at| now >= at)
    }

    /// Drop entries past the attempt cap or age; count them as dropped.
    fn expire(&mut self, now_epoch_ms: u64, max_attempts: u32, dropped: &AtomicU64) {
        let before = self.queue.len();
        self.queue.retain(|entry| {
            entry.attempts < max_attempts
                && now_epoch_ms.saturating_sub(entry.event.timestamp_ms)
                    < MAX_AGE.as_millis() as u64
        });
        let expired = before - self.queue.len();
        if expired > 0 {
            dropped.fetch_add(expired as u64, Ordering::Relaxed);
        }
    }
}

impl TelemetryClientConfig {
    /// The backoff after `attempts` failed sends:
    /// `min(max_backoff, flush_interval * 2^attempts)`.
    fn retry_backoff(&self, attempts: u32) -> Duration {
        self.flush_interval
            .saturating_mul(1 << attempts.min(16))
            .min(self.retry.max_backoff)
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use crate::properties::Properties;
    use crate::{MockSink, RecordedBatch};

    fn client_with(
        mock: Arc<MockSink>,
        batch_size: usize,
        flush_interval: Duration,
    ) -> TelemetryClient {
        let mut config = TelemetryClientConfig::new("install-1");
        config.batch_size = batch_size;
        config.flush_interval = flush_interval;
        config.sinks = vec![mock as Arc<dyn TelemetrySink>];
        TelemetryClient::spawn(config).expect("spawn client")
    }

    #[test]
    fn defaults_match_the_2117_delivery_contract() {
        assert_eq!(DEFAULT_BATCH_SIZE, 20);
        assert_eq!(DEFAULT_QUEUE_CAPACITY, 256);
        assert_eq!(DEFAULT_MAX_BATCH_BYTES, 30_000);
        assert_eq!(MAX_AGE, Duration::from_hours(24));
        assert_eq!(RetryPolicy::default().max_attempts, 5);
        assert_eq!(RetryPolicy::default().max_backoff, Duration::from_secs(60));
    }

    #[test]
    fn retry_backoff_is_interval_scaled_and_capped() {
        let mut config = TelemetryClientConfig::new("install-1");
        config.flush_interval = Duration::from_secs(10);
        assert_eq!(config.retry_backoff(1), Duration::from_secs(20));
        assert_eq!(config.retry_backoff(2), Duration::from_secs(40));
        assert_eq!(config.retry_backoff(3), Duration::from_secs(60), "capped");
        assert_eq!(config.retry_backoff(9), Duration::from_secs(60), "capped");
    }

    #[tokio::test]
    async fn batch_size_triggers_flush() {
        let mock = Arc::new(MockSink::new());
        let client = client_with(mock.clone(), 3, Duration::from_secs(60));
        for i in 0..2 {
            client.track(format!("event {i}"), Properties::new());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(mock.batches().len(), 0, "below batch size, no flush yet");
        client.track("event 2", Properties::new());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(mock.event_names(), vec!["event 0", "event 1", "event 2"]);
        client.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn explicit_flush_drains_partial_batches() {
        let mock = Arc::new(MockSink::new());
        let client = client_with(mock.clone(), 10, Duration::from_secs(60));
        client.track("solo", Properties::new());
        assert_eq!(mock.batches().len(), 0);
        client.flush().await.unwrap();
        assert_eq!(mock.event_names(), vec!["solo"]);
        assert_eq!(mock.batches()[0].install_id, "install-1");
        client.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn interval_flushes_without_batch_fill() {
        let mock = Arc::new(MockSink::new());
        let client = client_with(mock.clone(), 100, Duration::from_millis(30));
        client.track("timer event", Properties::new());
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(mock.event_names(), vec!["timer event"]);
        client.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_flushes_and_stops() {
        let mock = Arc::new(MockSink::new());
        let client = client_with(mock.clone(), 100, Duration::from_secs(60));
        client.track("last", Properties::new());
        client.shutdown().await.unwrap();
        assert_eq!(mock.event_names(), vec!["last"]);
        client.track("after shutdown", Properties::new());
        assert_eq!(client.dropped_count(), 1);
        assert_eq!(mock.event_names(), vec!["last"]);
    }

    #[tokio::test]
    async fn base_properties_merge_under_event_properties() {
        let mock = Arc::new(MockSink::new());
        let mut config = TelemetryClientConfig::new("install-1");
        config.batch_size = 1;
        config.flush_interval = Duration::from_secs(60);
        config.sinks = vec![mock.clone() as Arc<dyn TelemetrySink>];
        let mut base = Properties::new();
        base.set("version", serde_json::Value::from("0.1.0"));
        base.set("shared", serde_json::Value::from("base"));
        config.base_properties = base;
        let client = TelemetryClient::spawn(config).unwrap();
        let mut properties = Properties::new();
        properties.set("shared", serde_json::Value::from("event"));
        properties.set("extra", serde_json::Value::from(1));
        client.track("merged", properties);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let events = mock.events();
        assert_eq!(
            events[0].properties.get("version"),
            Some(&serde_json::Value::from("0.1.0"))
        );
        assert_eq!(
            events[0].properties.get("shared"),
            Some(&serde_json::Value::from("event"))
        );
        assert_eq!(
            events[0].properties.get("extra"),
            Some(&serde_json::Value::from(1))
        );
        client.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn queue_cap_drops_oldest_per_channel() {
        let mock = Arc::new(MockSink::new());
        let mut config = TelemetryClientConfig::new("install-1");
        config.batch_size = 1000; // never self-flush; queue only
        config.flush_interval = Duration::from_secs(60);
        config.queue_capacity = 4;
        config.sinks = vec![mock.clone() as Arc<dyn TelemetrySink>];
        let client = TelemetryClient::spawn(config).unwrap();
        for i in 0..10 {
            client.track(format!("e{i}"), Properties::new());
        }
        // Let the worker drain the channel before inspecting the drop counter.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(client.dropped_count(), 6);
        client.flush().await.unwrap();
        assert_eq!(mock.event_names(), vec!["e6", "e7", "e8", "e9"]);
        client.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn fan_out_delivers_to_every_sink() {
        let a = Arc::new(MockSink::new());
        let b = Arc::new(MockSink::new());
        let mut config = TelemetryClientConfig::new("install-1");
        config.batch_size = 1;
        config.flush_interval = Duration::from_secs(60);
        config.sinks = vec![
            a.clone() as Arc<dyn TelemetrySink>,
            b.clone() as Arc<dyn TelemetrySink>,
        ];
        let client = TelemetryClient::spawn(config).unwrap();
        client.track("fanned", Properties::new());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(a.event_names(), vec!["fanned"]);
        assert_eq!(b.event_names(), vec!["fanned"]);
        client.shutdown().await.unwrap();
    }

    /// A sink that fails `fail_times` batches, then succeeds.
    struct FlakySink {
        shared: Arc<MockSink>,
        remaining: AtomicU32,
    }

    impl FlakySink {
        fn new(shared: Arc<MockSink>, fail_times: u32) -> Arc<Self> {
            Arc::new(Self {
                shared,
                remaining: AtomicU32::new(fail_times),
            })
        }
    }

    impl TelemetrySink for FlakySink {
        fn send_batch<'a>(
            &'a self,
            install_id: &'a str,
            events: Vec<TelemetryEvent>,
        ) -> Pin<Box<dyn Future<Output = SinkOutcome> + Send + 'a>> {
            Box::pin(async move {
                if self
                    .remaining
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                        remaining.checked_sub(1)
                    })
                    .is_ok()
                {
                    return SinkOutcome::Dropped;
                }
                self.shared.send_batch(install_id, events).await
            })
        }
    }

    /// A dropped batch requeues and delivers after the backoff - exactly
    /// once, never duplicated (the offline/retry edge case).
    #[tokio::test]
    async fn failed_batch_retries_after_backoff_and_delivers_once() {
        let delivered = Arc::new(MockSink::new());
        let mut config = TelemetryClientConfig::new("install-1");
        config.batch_size = 10;
        config.flush_interval = Duration::from_millis(10);
        config.sinks = vec![FlakySink::new(delivered.clone(), 2) as Arc<dyn TelemetrySink>];
        let client = TelemetryClient::spawn(config).unwrap();
        client.track("offline event", Properties::new());
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(
            delivered.event_names(),
            vec!["offline event"],
            "delivered exactly once after two failed attempts"
        );
        assert_eq!(client.dropped_count(), 0);
        client.shutdown().await.unwrap();
    }

    /// A permanently failing channel expires at the attempt cap; a healthy
    /// sibling channel never sees a duplicate (per-channel queues).
    #[tokio::test]
    async fn permanently_failing_channel_expires_without_duplicating_sibling() {
        let failing = Arc::new(MockSink::failing());
        let healthy = Arc::new(MockSink::new());
        let mut config = TelemetryClientConfig::new("install-1");
        config.batch_size = 10;
        config.flush_interval = Duration::from_millis(10);
        config.sinks = vec![
            failing as Arc<dyn TelemetrySink>,
            healthy.clone() as Arc<dyn TelemetrySink>,
        ];
        let client = TelemetryClient::spawn(config).unwrap();
        client.track("survives", Properties::new());
        // The failure/retry/expiry cycle completes well inside this
        // window at the 10ms interval (backoffs 20+40+80+160ms).
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert_eq!(
            healthy.event_names(),
            vec!["survives"],
            "the healthy channel saw the event exactly once"
        );
        assert!(
            client.dropped_count() >= 1,
            "the failing channel expired its entry"
        );
        client.shutdown().await.unwrap();
    }

    /// The batch byte cap splits oversized batches (a single over-budget
    /// event still ships).
    #[tokio::test]
    async fn batch_byte_cap_splits_batches() {
        let mock = Arc::new(MockSink::new());
        let mut config = TelemetryClientConfig::new("install-1");
        config.batch_size = 20;
        config.flush_interval = Duration::from_secs(60);
        config.max_batch_bytes = 1_000;
        config.sinks = vec![mock.clone() as Arc<dyn TelemetrySink>];
        let client = TelemetryClient::spawn(config).unwrap();
        for i in 0..3 {
            let mut properties = Properties::new();
            properties.set("padding", serde_json::Value::from("x".repeat(600)));
            client.track(format!("fat {i}"), properties);
        }
        client.flush().await.unwrap();
        let batches: Vec<RecordedBatch> = mock.batches();
        assert_eq!(batches.len(), 3, "each fat event ships alone");
        assert_eq!(mock.event_names(), vec!["fat 0", "fat 1", "fat 2"]);
        client.shutdown().await.unwrap();
    }

    /// Entries older than the retention expire on the next flush.
    #[tokio::test]
    async fn aged_entries_expire() {
        let mut channel = Channel {
            sink: Arc::new(MockSink::new()),
            queue: VecDeque::new(),
            next_retry_at: None,
        };
        let fresh = TelemetryEvent {
            name: "fresh".into(),
            timestamp_ms: now_epoch_ms_for_tests(),
            properties: Properties::new(),
        };
        let stale = TelemetryEvent {
            name: "stale".into(),
            timestamp_ms: now_epoch_ms_for_tests().saturating_sub(MAX_AGE.as_millis() as u64 + 1),
            properties: Properties::new(),
        };
        channel.queue.push_back(QueueEntry {
            event: fresh,
            attempts: 0,
        });
        channel.queue.push_back(QueueEntry {
            event: stale,
            attempts: 0,
        });
        let dropped = Arc::new(AtomicU64::new(0));
        channel.expire(now_epoch_ms_for_tests(), 5, &dropped);
        assert_eq!(channel.queue.len(), 1);
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
        assert_eq!(channel.queue[0].event.name, "fresh");
    }

    /// Entries at the attempt cap expire even when fresh.
    #[tokio::test]
    async fn capped_attempts_expire() {
        let mut channel = Channel {
            sink: Arc::new(MockSink::new()),
            queue: VecDeque::new(),
            next_retry_at: None,
        };
        channel.queue.push_back(QueueEntry {
            event: TelemetryEvent::new("exhausted", Properties::new()),
            attempts: 5,
        });
        let dropped = Arc::new(AtomicU64::new(0));
        channel.expire(now_epoch_ms_for_tests(), 5, &dropped);
        assert!(channel.queue.is_empty());
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
    }

    fn now_epoch_ms_for_tests() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default()
    }

    /// Every event a batch carries is catalog-sanitized (the adjust layer
    /// drops unknown properties before any sink sees them).
    #[tokio::test]
    async fn flush_sanitizes_events_against_the_catalog() {
        let mock = Arc::new(MockSink::new());
        let client = client_with(mock.clone(), 1, Duration::from_secs(60));
        let mut properties = Properties::new();
        properties.set(
            "session_id",
            serde_json::Value::from("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a"),
        );
        properties.set("trigger", serde_json::Value::from("spontaneous"));
        properties.set("secret_path", serde_json::Value::from("/home/user/project"));
        client.track("agent run started", properties);
        client.flush().await.unwrap();
        let events = mock.events();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].properties.get("trigger"),
            Some(&serde_json::Value::from("unknown")),
            "out-of-vocabulary trigger fell back"
        );
        assert!(
            events[0].properties.get("secret_path").is_none(),
            "uncatalogued property dropped at the sink boundary"
        );
        client.shutdown().await.unwrap();
    }
}
