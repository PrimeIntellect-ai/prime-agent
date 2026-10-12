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
/// same event ids.
#[derive(Clone)]
pub struct AnalyticsSink {
    /// The built client, or the loud extra-CA trust error the construction
    /// ran into (a sink never fails the agent by contract, so the trust
    /// error is printed at construction and the batches drop).
    http: Result<reqwest::Client, String>,
    endpoint: String,
}

impl AnalyticsSink {
    /// Sink posting to `endpoint` (the product passes [`ANALYTICS_ENDPOINT`];
    /// tests pass a local stub) with the TS-parity 1.5s request timeout.
    #[must_use]
    pub fn new(endpoint: impl Into<String>) -> Self {
        Self::with_timeout(endpoint, DEFAULT_REQUEST_TIMEOUT)
    }

    /// Sink with an explicit request timeout (tests).
    #[must_use]
    pub fn with_timeout(endpoint: impl Into<String>, timeout: Duration) -> Self {
        // The shared extra-CA TLS contract: a trust source that cannot be
        // loaded prints its loud, path-naming error (this sink never fails
        // the agent by contract) and the batches drop.
        let http = pa_types::tls::extra_ca_client_config(pa_types::tls::TlsAlpn::Http1)
            .map_err(|error| error.to_string())
            .and_then(|config| {
                let builder = reqwest::Client::builder().timeout(timeout);
                match config {
                    Some(config) => builder
                        .use_preconfigured_tls(config)
                        .build()
                        .map_err(|error| error.to_string()),
                    None => builder.build().map_err(|error| error.to_string()),
                }
            });
        if let Err(cause) = &http {
            eprintln!("pa-telemetry: analytics sink: {cause}");
        }
        Self {
            http,
            endpoint: endpoint.into(),
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
            if events.is_empty() {
                return SinkOutcome::Sent;
            }
            // The trust variables name a source that cannot be loaded: the
            // construction already printed the loud, path-naming error; the
            // batches drop like any transport failure.
            let Ok(http) = &self.http else {
                return SinkOutcome::Dropped;
            };
            let response = http
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
