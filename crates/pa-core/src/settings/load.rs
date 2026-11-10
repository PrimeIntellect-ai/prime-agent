//! Lenient settings loading: wrong-typed fields load as `None` (TS
//! access-time typecheck semantics), never a load error.

use serde_json::Value;

use super::types::{A2aSettings, Settings};

/// One `a2a` object with only the members that parse: a wrong-typed
/// member (a quoted port, a negative bound) drops ALONE, never its
/// siblings — the settings contract says a wrong-typed value loads as
/// unset, and a configured token must not disappear because a different
/// member failed (AUTO-MINT would then mint a replacement, leaving every
/// holder of the configured token answering 401). Every member parses on
/// its own — no separate name list to keep in step with the struct (an
/// unknown member parses `Ok` and survives, the same as the outer loop's
/// unknown keys).
fn lenient_a2a(value: &Value) -> Value {
    if serde_json::from_value::<A2aSettings>(value.clone()).is_ok() {
        return value.clone();
    }
    let mut cleaned = serde_json::Map::new();
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    for (member, field) in object {
        let mut single = serde_json::Map::new();
        single.insert(member.clone(), field.clone());
        if serde_json::from_value::<A2aSettings>(Value::Object(single)).is_err() {
            // The wrong-typed member loads as unset.
            continue;
        }
        cleaned.insert(member.clone(), field.clone());
    }
    Value::Object(cleaned)
}

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
    "harnessRefinements",
    "agentTraces",
    "factory",
    "telemetry",
    "branchSummary",
    "retry",
    "providerBackupModel",
    "imageModel",
    "autonomous",
    "shellPath",
    "quietStartup",
    "shellCommandPrefix",
    "npmCommand",
    "mcpServers",
    "mcpCatalogSources",
    "packages",
    "skills",
    "prompts",
    "themes",
    "enableSkillCommands",
    "bundledSkills",
    "webSearchProvider",
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
    "emojiShortcodes",
    "markdown",
    "warnings",
    "sessionDir",
    "requestTiming",
    "pythonCellTimeoutMs",
];

/// Extract each known field independently; ignore fields whose JSON type does not match the Rust
/// schema (the TS getters do the same check at access time). Unknown keys land in `extra`.
pub fn from_value_lenient(value: &Value) -> Settings {
    if let Ok(settings) = serde_json::from_value::<Settings>(value.clone()) {
        return settings;
    }
    let Some(obj) = value.as_object() else {
        return Settings::default();
    };
    let mut map = serde_json::Map::new();
    for (key, field) in obj {
        // The nested `a2a` object re-parses member by member first (see
        // `lenient_a2a`): its own bad members drop alone.
        let field = if key == "a2a" {
            lenient_a2a(field)
        } else {
            field.clone()
        };
        // Re-parse per field: a bad-typed field drops out instead of failing the document.
        let mut single = serde_json::Map::new();
        single.insert(key.clone(), field.clone());
        let document = Value::Object(single);
        if let Ok(partial) = serde_json::from_value::<Settings>(document) {
            // A wrong-typed known field survives as a raw value in `extra` (serde flatten falls
            // back to the catch-all). Such a field must be dropped entirely: it behaves as unset.
            // Genuine unknown keys keep flowing through `extra`.
            if KNOWN_FIELDS.contains(&key.as_str()) && partial.extra.contains_key(key) {
                continue;
            }
            let merged = serde_json::to_value(partial).unwrap_or_default();
            if let Some(merged_obj) = merged.as_object() {
                for (k, v) in merged_obj {
                    // Partial serializations emit explicit nulls for every unset field; a null must
                    // not erase a value collected from an earlier partial.
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
    fn one_wrong_typed_a2a_member_drops_alone() {
        // The token contract: a wrong-typed sibling (a quoted port, a
        // negative bound) loads as unset alone — never dropping the
        // configured token with it (AUTO-MINT would mint a replacement
        // and leave this token's holders answering 401).
        let value: Value = serde_json::json!({
            "defaultModel": "test-model",
            "a2a": {
                "token": "secret-token",
                "port": "7800",
                "maxContexts": -1,
                "publicBaseUrl": "https://agent.example.com/"
            }
        });
        let settings = from_value_lenient(&value);
        let a2a = settings
            .a2a
            .expect("the a2a object survives its bad members");
        assert_eq!(a2a.token.as_deref(), Some("secret-token"));
        assert_eq!(a2a.port, None);
        assert_eq!(a2a.max_contexts, None);
        assert_eq!(
            a2a.public_base_url.as_deref(),
            Some("https://agent.example.com/")
        );
        assert_eq!(
            settings.default_model.as_deref(),
            Some("test-model"),
            "the sibling top-level field stays loaded too"
        );
    }

    /// The member-by-member clean parses every member on its own, with
    /// no name list to drift behind the struct: an unknown sibling (a
    /// member a future struct gain would carry) survives beside a
    /// wrong-typed one while the token stays loaded and the wrong
    /// member drops alone.
    #[test]
    fn an_unknown_a2a_member_survives_beside_a_wrong_typed_one() {
        let value: Value = serde_json::json!({
            "a2a": {
                "token": "secret-token",
                "port": "7800",
                "futureKnob": {"tuned": true}
            }
        });
        let settings = from_value_lenient(&value);
        let a2a = settings
            .a2a
            .expect("the a2a object survives its bad members");
        assert_eq!(a2a.token.as_deref(), Some("secret-token"));
        assert_eq!(a2a.port, None);
    }

    #[test]
    fn a_wrong_typed_whole_a2a_object_loads_as_unset() {
        let value: Value = serde_json::json!({ "a2a": "not-an-object" });
        let settings = from_value_lenient(&value);
        assert_eq!(settings.a2a, None);
    }

    #[test]
    fn wrong_typed_python_cell_timeout_loads_as_unset() {
        // A known field: a wrong-typed value must behave as unset (the
        // getter's default), not survive raw in `extra` where a save
        // would persist the bad key.
        let value: Value = serde_json::json!({
            "pythonCellTimeoutMs": "sixty seconds",
            "pythonCellTimeoutValid": 30_000
        });
        let settings = from_value_lenient(&value);
        assert_eq!(settings.python_cell_timeout_ms, None);
        assert!(
            !settings.extra.contains_key("pythonCellTimeoutMs"),
            "a wrong-typed known field never rides extra into a save"
        );
        assert_eq!(
            settings.extra.get("pythonCellTimeoutValid"),
            Some(&serde_json::json!(30_000)),
            "genuine unknown keys keep flowing through extra"
        );
    }

    #[test]
    fn clean_document_strict_parses() {
        let value: Value = serde_json::json!({ "theme": "prime", "rlmMaxDepth": 4 });
        let settings = from_value_lenient(&value);
        assert_eq!(settings.theme.as_deref(), Some("prime"));
        assert_eq!(settings.rlm_max_depth, Some(4));
    }

    #[test]
    fn removed_extensions_key_loads_gracefully() {
        let value: Value = serde_json::json!({
            "extensions": ["~/my-ext/index.ts"],
            "skills": ["~/my-skill"]
        });
        let settings = from_value_lenient(&value);
        assert_eq!(settings.skills, Some(vec!["~/my-skill".to_string()]));
        assert_eq!(
            settings.extra.get("extensions"),
            Some(&serde_json::json!(["~/my-ext/index.ts"])),
            "the dead key is preserved untouched in extra, never parsed"
        );
    }

    /// A wrong-typed `requestTiming` behaves as unset (the known-field
    /// registry entry), never a surviving raw value.
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
