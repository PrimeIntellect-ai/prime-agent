//! # pa-telemetry
//!
//! Modular telemetry over a primitive-only property schema: non-blocking
//! [`TelemetryClient::track`], batched [`TelemetrySink`] delivery, and the
//! pseudonymous installation identity.

// Casts narrow values that are validated or structurally bounded (millisecond
// durations, clamped property bounds, non-negative JSON numbers); guarded
// conversions would add panic paths the bounds guarantee away.
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
    UpdateHomebrewRefusal,
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
