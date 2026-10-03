//! # pa-telemetry
//!
//! Modular telemetry for Prime Agent: a small client surface
//! ([`TelemetryClient::track`], [`TelemetryClient::flush`],
//! [`TelemetryClient::shutdown`]), a primitive-only property schema, batched
//! delivery to pluggable [`TelemetrySink`]s, and the pseudonymous
//! installation identity.
//!
//! Privacy contract: properties are JSON primitives only; no prompt, session,
//! or tool content is ever emitted. Telemetry is best-effort and must never
//! block or fail the agent.

// Pedantic-gate exceptions (every other pedantic warning in this crate is
// fixed in place; each exception carries its one-line justification):
// - the casts: wire-format and duration arithmetic narrows validated or
//   structurally bounded values (millisecond durations, clamped property
//   bounds, non-negative-guarded JSON numbers); guarded conversions would
//   add panic paths the bounds guarantee away.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

mod catalog;
mod client;
mod env;
mod event;
mod events;
mod install_id;
mod platform;
mod properties;
mod rename;
mod sink;
mod sinks;
mod time;

static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Set the product version stamped on every event and on outgoing requests
/// (`prime-agent/<version>`). The binary passes its runtime version: a
/// release restamps the packaged manifest, not the compiled-in crate
/// version. The first call wins.
pub fn set_version(version: &str) {
    let _ = VERSION.set(version.to_string());
}

/// The product version: the one given to [`set_version`], else the
/// compiled-in crate version.
#[must_use]
pub fn version() -> &'static str {
    VERSION
        .get()
        .map_or(env!("CARGO_PKG_VERSION"), String::as_str)
}

pub use catalog::{
    catalog, feature_outcome_key, input_stage_key, lookup, sanitize, EventRule, PropKind,
    PropertyRule, AUTH_CATEGORIES, BUILD_CHANNELS, ERROR_CATEGORIES, ERROR_SUBTYPES, FEATURE_NAMES,
    FEATURE_OUTCOMES, INPUT_STAGES, INSTALLATION_ACTIONS, INSTALLATION_OUTCOMES,
    INSTALLATION_REASONS, INSTALLATION_SOURCES, INSTALLATION_STAGES, MODEL_CATEGORIES,
    ONBOARDING_ENTRY_REASONS, ONBOARDING_OUTCOMES, ONBOARDING_STAGES, PROVIDER_CATEGORIES,
    READY_KINDS, RUN_TRIGGERS, STARTUP_KINDS, STARTUP_OUTCOMES, STARTUP_STAGES, STOP_REASONS,
    TERMINAL_OUTCOMES, TOOL_CATEGORIES, WORKLOAD_ORIGINS,
};
pub use client::{TelemetryClient, TelemetryClientConfig};
pub use env::parse_bool_override;
pub use event::TelemetryEvent;
pub use events::{
    AgentInstallationStage, AgentStartupStage, OnboardingStage, RunTrigger, ToolCategory,
};
pub use install_id::{existing_install_id, install_id};
pub use platform::{base_properties, SCHEMA_VERSION};
pub use properties::Properties;
pub use rename::rename_onto;
pub use sink::{SinkOutcome, TelemetrySink};
pub use sinks::{AnalyticsSink, FileSink, MockSink, NoopSink, RecordedBatch, ANALYTICS_ENDPOINT};

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;

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

    #[tokio::test]
    async fn batch_size_triggers_flush() {
        let mock = Arc::new(MockSink::new());
        let client = client_with(mock.clone(), 3, Duration::from_mins(1));
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
        let client = client_with(mock.clone(), 10, Duration::from_mins(1));
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
        let client = client_with(mock.clone(), 100, Duration::from_mins(1));
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
        config.flush_interval = Duration::from_mins(1);
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
    async fn queue_cap_drops_oldest() {
        let mock = Arc::new(MockSink::new());
        let mut config = TelemetryClientConfig::new("install-1");
        config.batch_size = 1000; // never self-flush; queue only
        config.flush_interval = Duration::from_mins(1);
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
        config.flush_interval = Duration::from_mins(1);
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

    #[tokio::test]
    async fn the_live_switch_drops_while_off_and_resumes_when_on() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let mock = Arc::new(MockSink::new());
        let on = Arc::new(AtomicBool::new(false));
        let mut config = TelemetryClientConfig::new("install-1");
        config.flush_interval = Duration::from_mins(1);
        config.sinks = vec![mock.clone() as Arc<dyn TelemetrySink>];
        let switch = Arc::clone(&on);
        config.enabled = Some(Arc::new(move || switch.load(Ordering::SeqCst)));
        let client = TelemetryClient::spawn(config).unwrap();
        client.track("while off", Properties::new());
        // The worker takes the event while off; telemetry is turned back
        // on before any delivery pass, and that event still never sends.
        tokio::time::sleep(Duration::from_millis(50)).await;
        on.store(true, Ordering::SeqCst);
        client.track("back on", Properties::new());
        client.flush().await.unwrap();
        assert_eq!(mock.event_names(), vec!["back on"]);
        assert_eq!(
            client.dropped_count(),
            1,
            "the event tracked while off is dropped"
        );
        client.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn failing_sink_never_propagates() {
        let failing = Arc::new(MockSink::failing());
        let healthy = Arc::new(MockSink::new());
        let mut config = TelemetryClientConfig::new("install-1");
        config.batch_size = 1;
        config.flush_interval = Duration::from_mins(1);
        config.sinks = vec![
            failing.clone() as Arc<dyn TelemetrySink>,
            healthy.clone() as Arc<dyn TelemetrySink>,
        ];
        let client = TelemetryClient::spawn(config).unwrap();
        client.track("survives", Properties::new());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(healthy.event_names(), vec!["survives"]);
        client.shutdown().await.unwrap();
    }
}
