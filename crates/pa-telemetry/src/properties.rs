//! Property maps for telemetry events.
//!
//! Contract: telemetry properties are JSON primitives only (string, number,
//! boolean, null). This is the privacy boundary - non-primitive values (objects,
//! arrays, content blocks, tool payloads) are rejected at insertion with a
//! warning instead of being emitted.

use serde::Serialize;
use serde_json::{Map, Value};

/// A primitive-only property map. Enforces the JSON-primitives contract at
/// every insertion point.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Properties(Map<String, Value>);

impl Properties {
    /// An empty map.
    pub fn new() -> Self {
        Self(Map::new())
    }

    /// Insert a property. Non-primitive values are rejected (warn + skip) so
    /// no structured payload can ever reach a sink.
    pub fn set(&mut self, key: &str, value: Value) {
        if !is_primitive(&value) {
            tracing::warn!(key, value = %value, "rejected non-primitive telemetry property");
            return;
        }
        self.0.insert(key.to_string(), value);
    }

    /// Merge every primitive of `other` into this map (later value wins).
    pub fn merge(&mut self, other: &Properties) {
        for (key, value) in other.iter() {
            self.0.insert(key.clone(), value.clone());
        }
    }

    /// Insert a nested primitive map (all values already primitive by
    /// construction). Used for aggregate fields like `phase_timings`.
    pub fn set_map(&mut self, key: &str, value: &Properties) {
        self.0
            .insert(key.to_string(), Value::Object(value.0.clone()));
    }

    /// Read back a property (test + schema-check surface).
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// Number of properties.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Iterate `(key, value)` pairs, values guaranteed primitive.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.0.iter()
    }

    /// Serialized form used by every sink (guaranteed an object).
    pub(crate) fn to_map(&self) -> &Map<String, Value> {
        &self.0
    }
}

impl From<Properties> for Map<String, Value> {
    fn from(value: Properties) -> Self {
        value.0
    }
}

/// True for JSON primitives only.
pub(crate) fn is_primitive(value: &Value) -> bool {
    matches!(
        value,
        Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_primitives() {
        let mut p = Properties::new();
        p.set("str", Value::from("v"));
        p.set("num", Value::from(42));
        p.set("bool", Value::from(true));
        p.set("null", Value::Null);
        assert_eq!(p.len(), 4);
        assert_eq!(p.get("num"), Some(&Value::from(42)));
    }

    #[test]
    fn rejects_structured_values() {
        let mut p = Properties::new();
        let structured = [
            Value::Array(vec![Value::from(1)]),
            Value::Object(Map::new()),
        ];
        for value in structured {
            p.set("bad", value.clone());
        }
        assert_eq!(p.get("bad"), None);
        assert!(p.is_empty());
    }

    #[test]
    fn set_map_embeds_primitive_map() {
        let mut timings = Properties::new();
        timings.set("models", Value::from(120));
        let mut p = Properties::new();
        p.set_map("phase_timings", &timings);
        let embedded = p.get("phase_timings").cloned().unwrap();
        assert_eq!(embedded, serde_json::json!({ "models": 120 }));
    }

    #[test]
    fn merge_later_wins() {
        let mut base = Properties::new();
        base.set("a", Value::from(1));
        base.set("shared", Value::from("base"));
        let mut over = Properties::new();
        over.set("b", Value::from(2));
        over.set("shared", Value::from("over"));
        base.merge(&over);
        assert_eq!(base.get("shared"), Some(&Value::from("over")));
        assert_eq!(base.get("b"), Some(&Value::from(2)));
        assert_eq!(base.len(), 3);
    }
}
