//! PostHog batched capture sink (primary product sink).
//!
//! Wire format is the PostHog capture v2 batch API: `POST {base}/batch/` with
//! `{"api_key", "batch": [{event, distinct_id, timestamp, properties}]}`.
//! Endpoint and project key come from configuration (env override, then
//! settings, resolved by the composition root); pa-telemetry ships no
//! compiled-in endpoint or key, so the stack is self-hostable and an empty
//! configuration resolves to `NoopSink` instead.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::json;

use crate::event::TelemetryEvent;
use crate::sink::{SinkOutcome, TelemetrySink};

/// TS parity: requests time out after 1.5s so telemetry never holds the agent.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);

/// A resolved PostHog endpoint: base URL + project capture key.
/// Built from env (`PRIME_AGENT_TELEMETRY_ENDPOINT` / `_API_KEY`) or from
/// settings `telemetry.posthog.*`; both fields must be non-empty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostHogEndpoint {
    /// Base URL, e.g. `https://us.i.posthog.com` (no trailing slash).
    pub endpoint: String,
    /// Project capture api key.
    pub api_key: String,
}

impl PostHogEndpoint {
    /// Resolve from env overrides. `None` when either variable is unset or
    /// empty (the caller then falls back to settings or `NoopSink`).
    pub fn from_env() -> Option<Self> {
        let endpoint = std::env::var("PRIME_AGENT_TELEMETRY_ENDPOINT")
            .ok()
            .and_then(trimmed_non_empty);
        let api_key = std::env::var("PRIME_AGENT_TELEMETRY_API_KEY")
            .ok()
            .and_then(trimmed_non_empty);
        Some(Self {
            endpoint: endpoint?,
            api_key: api_key?,
        })
    }

    pub fn new(endpoint: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            api_key: api_key.into(),
        }
    }

    fn batch_url(&self) -> String {
        format!("{}/batch/", self.endpoint.trim_end_matches('/'))
    }
}

fn trimmed_non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// The primary sink: batches to PostHog. Best-effort — any non-2xx response,
/// transport error, or timeout drops the batch (offline-safe, no retries).
#[derive(Clone)]
pub struct PostHogSink {
    http: reqwest::Client,
    batch_url: String,
    api_key: String,
}

impl PostHogSink {
    /// Sink with the TS-parity 1.5s request timeout.
    pub fn new(endpoint: &PostHogEndpoint) -> Self {
        Self::with_timeout(endpoint, DEFAULT_REQUEST_TIMEOUT)
    }

    /// Sink with an explicit request timeout (tests).
    pub fn with_timeout(endpoint: &PostHogEndpoint, timeout: Duration) -> Self {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .expect("reqwest client with rustls");
        Self {
            http,
            batch_url: endpoint.batch_url(),
            api_key: endpoint.api_key.clone(),
        }
    }

    /// The batch request body as it goes on the wire.
    pub(crate) fn batch_body(
        &self,
        install_id: &str,
        events: &[TelemetryEvent],
    ) -> serde_json::Value {
        json!({
            "api_key": self.api_key,
            "batch": events
                .iter()
                .map(|event| {
                    json!({
                        "event": event.name,
                        "distinct_id": install_id,
                        "timestamp": event.timestamp_iso8601(),
                        "properties": event.properties.to_map(),
                    })
                })
                .collect::<Vec<_>>(),
        })
    }
}

impl TelemetrySink for PostHogSink {
    fn send_batch<'a>(
        &'a self,
        install_id: &'a str,
        events: Vec<TelemetryEvent>,
    ) -> Pin<Box<dyn Future<Output = SinkOutcome> + Send + 'a>> {
        Box::pin(async move {
            if events.is_empty() {
                return SinkOutcome::Sent;
            }
            let body = self.batch_body(install_id, &events);
            let response = self
                .http
                .post(&self.batch_url)
                .header("content-type", "application/json")
                .header("user-agent", format!("prime-agent/{}", crate::VERSION))
                .json(&body)
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => SinkOutcome::Sent,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::properties::Properties;

    fn event(name: &str) -> TelemetryEvent {
        let mut properties = Properties::new();
        properties.set("version", serde_json::Value::from("0.1.0"));
        TelemetryEvent::new(name, properties)
    }

    #[test]
    fn batch_body_wire_shape() {
        let sink = PostHogSink::new(&PostHogEndpoint::new("https://ph.example", "phc-key"));
        let body = sink.batch_body("install-1", &[event("agent started")]);
        assert_eq!(body["api_key"], "phc-key");
        assert_eq!(body["batch"][0]["event"], "agent started");
        assert_eq!(body["batch"][0]["distinct_id"], "install-1");
        assert_eq!(body["batch"][0]["properties"]["version"], "0.1.0");
        assert!(body["batch"][0]["timestamp"]
            .as_str()
            .unwrap()
            .ends_with('Z'));
    }

    #[test]
    fn endpoint_env_resolution_requires_both() {
        // No env: absent.
        std::env::remove_var("PRIME_AGENT_TELEMETRY_ENDPOINT");
        std::env::remove_var("PRIME_AGENT_TELEMETRY_API_KEY");
        assert_eq!(PostHogEndpoint::from_env(), None);
        std::env::set_var("PRIME_AGENT_TELEMETRY_ENDPOINT", "https://ph.example/");
        assert_eq!(PostHogEndpoint::from_env(), None);
        std::env::set_var("PRIME_AGENT_TELEMETRY_API_KEY", " phc-key ");
        let resolved = PostHogEndpoint::from_env().expect("both set");
        assert_eq!(
            resolved,
            PostHogEndpoint::new("https://ph.example/", "phc-key")
        );
        assert_eq!(resolved.batch_url(), "https://ph.example/batch/");
        std::env::remove_var("PRIME_AGENT_TELEMETRY_ENDPOINT");
        std::env::remove_var("PRIME_AGENT_TELEMETRY_API_KEY");
    }

    #[tokio::test]
    async fn empty_batch_short_circuits() {
        let sink = PostHogSink::new(&PostHogEndpoint::new("http://127.0.0.1:1", "phc-key"));
        let outcome = sink.send_batch("install-1", vec![]).await;
        assert_eq!(outcome, SinkOutcome::Sent);
    }
}
