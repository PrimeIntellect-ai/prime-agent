//! The Prime Intellect analytics sink (the default product sink).
//!
//! Wire format is the TS product's (`core/telemetry.ts` `TelemetryClient`):
//! `POST <endpoint>` with `{"installation_id", "events": [{"id", "name",
//! "timestamp", "properties"}]}`, `content-type: application/json`,
//! `user-agent: prime-agent/<version>`, no credentials. The platform backend
//! forwards each event to `PostHog` with `distinct_id = installation_id`
//! and `uuid = id`, so Rust and TS installs count as the same users.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::{json, Value};

use crate::event::TelemetryEvent;
use crate::sink::{SinkOutcome, TelemetrySink};

/// The TS product's endpoint: the one destination for product telemetry.
pub const ANALYTICS_ENDPOINT: &str = "https://api.primeintellect.ai/api/v1/agent-analytics/events";

/// TS parity: requests time out after 1.5s so telemetry never holds the agent.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);

/// Batches to the analytics endpoint. Best-effort: a transport error,
/// timeout, non-2xx status, or a 2xx that accepted nothing (the backend
/// answers `{"accepted": 0}` when its `PostHog` delivery failed) reports
/// [`SinkOutcome::Dropped`], and the client's bounded retry re-sends the
/// same event ids. Explicit test/eval workloads are consumed without an
/// HTTP request or retry; other sinks can still keep local diagnostics.
#[derive(Clone)]
pub struct AnalyticsSink {
    http: reqwest::Client,
    endpoint: String,
    suppressed: bool,
}

impl AnalyticsSink {
    /// Sink posting to `endpoint` (the product passes [`ANALYTICS_ENDPOINT`];
    /// tests pass a local stub) with the TS-parity 1.5s request timeout.
    #[must_use]
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self::with_timeout(endpoint, DEFAULT_REQUEST_TIMEOUT)
    }

    /// Sink with an explicit request timeout (tests).
    ///
    /// # Panics
    ///
    /// Panics if the reqwest HTTP client cannot be built.
    #[must_use]
    pub fn with_timeout(endpoint: impl Into<String>, timeout: Duration) -> Self {
        Self::with_timeout_and_builder(endpoint, timeout, reqwest::Client::builder())
    }

    /// Sink using the caller's HTTP trust configuration and the TS-parity
    /// 1.5s request timeout. Product composition supplies its extra CA roots.
    ///
    /// # Panics
    ///
    /// Panics if the supplied HTTP client builder cannot be built.
    #[must_use]
    pub fn with_http_builder(
        endpoint: impl Into<String>,
        http_builder: reqwest::ClientBuilder,
    ) -> Self {
        Self::with_timeout_and_builder(endpoint, DEFAULT_REQUEST_TIMEOUT, http_builder)
    }

    fn with_timeout_and_builder(
        endpoint: impl Into<String>,
        timeout: Duration,
        http_builder: reqwest::ClientBuilder,
    ) -> Self {
        let http = http_builder
            .timeout(timeout)
            .build()
            .expect("reqwest client with rustls");
        Self {
            http,
            endpoint: endpoint.into(),
            // Snapshot the harness identity before events queue. An explicit
            // telemetry opt-in must never turn a synthetic run into adoption.
            suppressed: crate::env::synthetic_workload(|key| {
                std::env::var_os(key).map(|value| value.to_string_lossy().into_owned())
            }),
        }
    }

    /// The request body as it goes on the wire.
    #[must_use]
    pub fn batch_body(install_id: &str, events: &[TelemetryEvent]) -> Value {
        json!({
            "installation_id": install_id,
            "events": events.iter().map(TelemetryEvent::to_value).collect::<Vec<_>>(),
        })
    }
}

impl TelemetrySink for AnalyticsSink {
    fn send_batch<'a>(
        &'a self,
        install_id: &'a str,
        events: Vec<TelemetryEvent>,
    ) -> Pin<Box<dyn Future<Output = SinkOutcome> + Send + 'a>> {
        Box::pin(async move {
            if self.suppressed {
                return SinkOutcome::Sent;
            }
            // Keep the event-time marker authoritative if the process marker
            // changes before a batch is delivered. Local mirrors remain useful.
            let events: Vec<_> = events
                .into_iter()
                .filter(|event| {
                    !matches!(
                        event
                            .properties
                            .get("workload_origin")
                            .and_then(Value::as_str),
                        Some("test" | "eval")
                    )
                })
                .collect();
            if events.is_empty() {
                return SinkOutcome::Sent;
            }
            let response = self
                .http
                .post(&self.endpoint)
                .header("content-type", "application/json")
                .header("user-agent", format!("prime-agent/{}", crate::version()))
                .json(&Self::batch_body(install_id, &events))
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => {
                    let accepted = response
                        .json::<Value>()
                        .await
                        .ok()
                        .and_then(|body| body.get("accepted").and_then(Value::as_u64));
                    if accepted == Some(0) {
                        tracing::debug!(
                            count = events.len(),
                            "telemetry batch accepted nothing, dropping"
                        );
                        SinkOutcome::Dropped
                    } else {
                        SinkOutcome::Sent
                    }
                }
                Ok(response) => {
                    tracing::debug!(
                        status = %response.status(),
                        count = events.len(),
                        "telemetry batch rejected, dropping"
                    );
                    SinkOutcome::Dropped
                }
                Err(err) => {
                    tracing::debug!(error = %err, count = events.len(), "telemetry batch send failed, dropping");
                    SinkOutcome::Dropped
                }
            }
        })
    }
}
