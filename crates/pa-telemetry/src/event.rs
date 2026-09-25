//! The telemetry event record.

use serde::Serialize;
use serde_json::{json, Value};

use crate::properties::Properties;
use crate::time::EpochMs;

/// A single telemetry event. Carries a stable event name (see
/// `docs/telemetry-events.md` for the versioned catalog) and a primitive-only
/// property map. Timestamps are captured at `track()` time.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TelemetryEvent {
    /// Stable event name, e.g. `agent started`.
    pub name: String,
    /// Milliseconds since the Unix epoch at emission time.
    pub timestamp_ms: u64,
    /// Primitive-only properties (base + event-specific, already merged).
    pub properties: Properties,
}

impl TelemetryEvent {
    /// New event stamped with the current time.
    pub fn new(name: impl Into<String>, properties: Properties) -> Self {
        Self {
            name: name.into(),
            timestamp_ms: EpochMs::now().0,
            properties,
        }
    }

    /// ISO-8601 UTC rendering of the timestamp, e.g. `2026-09-29T16:51:45.951Z`.
    pub fn timestamp_iso8601(&self) -> String {
        EpochMs(self.timestamp_ms).iso8601()
    }

    /// The sink-facing object form: `{"name", "timestamp" (ISO-8601),
    /// "properties"}`. Sinks lift fields from this shape into their wire
    /// format (`PostHog` `event`/`timestamp`, JSONL mirror adds `distinct_id`).
    pub(crate) fn to_value(&self) -> Value {
        json!({
            "name": self.name,
            "timestamp": self.timestamp_iso8601(),
            "properties": Value::Object(self.properties.to_map().clone()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_value_shape() {
        let mut properties = Properties::new();
        properties.set("outcome", serde_json::Value::from("success"));
        let event = TelemetryEvent::new("agent run completed", properties);
        let value = event.to_value();
        assert_eq!(value["name"], "agent run completed");
        assert_eq!(value["properties"]["outcome"], "success");
        assert!(value["timestamp"].as_str().unwrap().ends_with('Z'));
    }
}
