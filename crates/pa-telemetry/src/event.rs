//! The telemetry event record.

use serde::Serialize;
use serde_json::{json, Value};

use crate::properties::Properties;
use crate::time::EpochMs;

/// A single telemetry event. Carries a stable event name and a
/// primitive-only property map. The id and timestamp are captured at
/// `track()` time, so a retried batch re-sends the same ids (the analytics
/// endpoint forwards the id as the `PostHog` event uuid, which dedupes).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TelemetryEvent {
    /// Random uuid v4 per event.
    pub id: String,
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
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            timestamp_ms: EpochMs::now().0,
            properties,
        }
    }

    /// ISO-8601 UTC rendering of the timestamp, e.g. `2026-09-29T16:51:45.951Z`.
    #[must_use]
    pub fn timestamp_iso8601(&self) -> String {
        EpochMs(self.timestamp_ms).iso8601()
    }

    /// The serialized size of the sink-facing object form; batches cap
    /// at a byte budget.
    pub(crate) fn wire_size_estimate(&self) -> usize {
        serde_json::to_string(&self.to_value()).map_or(0, |text| text.len())
    }

    /// The sink-facing object form: `{"id", "name", "timestamp" (ISO-8601),
    /// "properties"}` - the analytics endpoint's event shape; the JSONL
    /// mirror adds `distinct_id`.
    pub(crate) fn to_value(&self) -> Value {
        json!({
            "id": self.id,
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
