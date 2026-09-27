//! Lenient settings loading: wrong-typed fields load as `None` (TS
//! access-time typecheck semantics), never a load error.

use serde_json::Value;

use super::types::Settings;

/// Known settings keys (the TS Settings interface, camelCase wire form).
/// Wrong-typed values for these load as unset; unknown keys are preserved.
const KNOWN_FIELDS: &[&str] = &[
    "onboardingShown",
    "onboardingCompleted",
    "defaultProvider",
    "defaultModel",
    "subagentDefaultModel",
    "updateChannel",
    "recentModels",
    "auxiliaryModel",
    "defaultThinkingLevel",
    "defaultServiceTier",
    "rlmMaxDepth",
    "idleEvictionMinutes",
    "transport",
    "steeringMode",
    "followUpMode",
    "theme",
    "compaction",
    "autoRefine",
    "agentTraces",
    "telemetry",
    "branchSummary",
    "retry",
    "providerBackupModel",
    "autonomous",
    "shellPath",
    "quietStartup",
    "shellCommandPrefix",
    "npmCommand",
    "mcpServers",
    "packages",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "enableSkillCommands",
    "bundledSkills",
    "enableBuiltinSkills",
    "terminal",
    "images",
    "enabledModels",
    "allowedModels",
    "treeFilterMode",
    "chatDetail",
    "thinkingBudgets",
    "editorPaddingX",
    "autocompleteMaxVisible",
    "showHardwareCursor",
    "markdown",
    "warnings",
    "sessionDir",
    "requestTiming",
];

/// Extract each known field independently; ignore fields whose JSON type does
/// not match the Rust schema (the TS getters do the same check at access
/// time). Unknown keys land in `extra`.
pub fn from_value_lenient(value: &Value) -> Settings {
    // Fast path: a clean strict parse.
    if let Ok(settings) = serde_json::from_value::<Settings>(value.clone()) {
        return settings;
    }
    let Some(obj) = value.as_object() else {
        return Settings::default();
    };
    let mut map = serde_json::Map::new();
    for (key, field) in obj {
        // Re-parse per field: a bad-typed field drops out instead of failing
        // the document.
        let mut single = serde_json::Map::new();
        single.insert(key.clone(), field.clone());
        let document = Value::Object(single);
        if let Ok(partial) = serde_json::from_value::<Settings>(document) {
            // A wrong-typed known field survives as a raw value in `extra`
            // (serde flatten falls back to the catch-all). Such a field must
            // be dropped entirely: it behaves as unset. Genuine unknown keys
            // keep flowing through `extra`.
            if KNOWN_FIELDS.contains(&key.as_str()) && partial.extra.contains_key(key) {
                continue;
            }
            let merged = serde_json::to_value(partial).unwrap_or_default();
            if let Some(merged_obj) = merged.as_object() {
                for (k, v) in merged_obj {
                    // Partial serializations emit explicit nulls for every
                    // unset field; a null must not erase a value collected
                    // from an earlier partial.
                    if v.is_null() {
                        continue;
                    }
                    map.insert(k.clone(), v.clone());
                }
            }
        }
    }
    serde_json::from_value::<Settings>(Value::Object(map)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrong_typed_fields_load_as_none() {
        let value: Value = serde_json::json!({
            "defaultProvider": 42,
            "steeringMode": "all",
            "recentModels": "not-an-array",
            "unknownKey": { "kept": true }
        });
        let settings = from_value_lenient(&value);
        assert_eq!(settings.default_provider, None);
        assert_eq!(
            settings.steering_mode,
            Some(super::super::types::QueueModeSetting::All)
        );
        assert_eq!(settings.recent_models, None);
        assert_eq!(
            settings.extra.get("unknownKey"),
            Some(&serde_json::json!({ "kept": true }))
        );
    }

    #[test]
    fn clean_document_strict_parses() {
        let value: Value = serde_json::json!({ "theme": "prime", "rlmMaxDepth": 4 });
        let settings = from_value_lenient(&value);
        assert_eq!(settings.theme.as_deref(), Some("prime"));
        assert_eq!(settings.rlm_max_depth, Some(4));
    }

    /// TS #2462: a wrong-typed `requestTiming` behaves as unset (the
    /// known-field registry entry), never a surviving raw value.
    #[test]
    fn wrong_typed_request_timing_loads_as_none() {
        let value: Value = serde_json::json!({ "requestTiming": "yes" });
        let settings = from_value_lenient(&value);
        assert_eq!(settings.request_timing, None);
        assert!(
            settings.extra.get("requestTiming").is_none(),
            "the wrong-typed known field drops out entirely: {:?}",
            settings.extra
        );
        let settings = from_value_lenient(&serde_json::json!({ "requestTiming": true }));
        assert_eq!(settings.request_timing, Some(true));
    }
}
