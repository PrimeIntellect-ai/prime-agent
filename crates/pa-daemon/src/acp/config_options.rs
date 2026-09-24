//! ACP session-config pickers (the TS #2455 port): `session/new`
//! advertises standard `model` and `thought_level` select options, and
//! `session/set_config_option` applies a client selection — validated
//! against the discovered models and the current model's supported
//! levels — republishing `config_option_update` whenever the observed
//! options change. Model values are opaque serialized
//! `[provider, model-id]` pairs, exactly like the TS product (Zed
//! round-trips the value it was handed); effort choices follow the
//! selected model's supported levels.
//!
//! Both transports serve the same computation: the in-process mode
//! reads the live agent state (plus the switchable provider target), the
//! daemon-attached transport rides the `get_connection_state` /
//! `get_available_models` / `set_model` / `set_thinking_level` wire
//! commands — the rust forms of the TS `AgentConnection` seams.

use std::path::Path;
use std::sync::Arc;

use pa_types::ai::Model;
use serde::Serialize;
use serde_json::Value;

use super::producer::UpdateProducer;
use super::types::AcpSessionUpdate;

/// One selectable value (ACP `SessionConfigSelectOption`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionConfigSelectOption {
    pub value: String,
    pub name: String,
}

/// One session configuration option (ACP `SessionConfigOption`, the
/// select form the product serves).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionConfigOption {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub category: String,
    #[serde(rename = "currentValue")]
    pub current_value: String,
    pub options: Vec<SessionConfigSelectOption>,
}

/// The current model as the pickers present it (the TS `state.model`):
/// identity plus the reasoning flag that gates the effort picker. The
/// daemon-attached transport parses the same shape off the
/// `get_connection_state` wire.
#[derive(Debug, Clone, PartialEq)]
pub struct PickerModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub reasoning: bool,
}

impl PickerModel {
    pub fn from_model(model: &Model) -> PickerModel {
        PickerModel {
            id: model.id.clone(),
            name: model.name.clone(),
            provider: model.provider.clone(),
            reasoning: model.reasoning,
        }
    }

    /// The full registry model's identity when discovery holds it (the
    /// supported-levels source), else the agent-state view.
    pub fn from_agent_model(model: &pa_agent::types::Model) -> PickerModel {
        PickerModel {
            id: model.id.clone(),
            name: model.name.clone(),
            provider: model.provider.clone(),
            reasoning: model.reasoning,
        }
    }

    /// Parse the `get_connection_state` `model` metadata (the daemon
    /// engine's `{ id, name, provider, reasoning }`).
    pub fn from_connection_state(value: &Value) -> Option<PickerModel> {
        Some(PickerModel {
            id: value.get("id")?.as_str()?.to_string(),
            name: value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            provider: value.get("provider")?.as_str()?.to_string(),
            reasoning: value
                .get("reasoning")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
}

/// The opaque model value the picker hands to clients: the serialized
/// `[provider, model-id]` pair (TS `modelValue`).
pub fn model_value(provider: &str, model_id: &str) -> String {
    serde_json::json!([provider, model_id]).to_string()
}

/// Build the session's configuration options (TS `sessionConfigOptions`):
/// a `model` select over the discovered models (the current model always
/// selectable), plus a `thought_level` select when the current model
/// supports reasoning and has available levels. No model resolves to no
/// options, exactly like the TS builder.
pub fn session_config_options(
    model: Option<PickerModel>,
    thinking_level: &str,
    available_levels: &[String],
    models: &[Model],
) -> Vec<SessionConfigOption> {
    let Some(model) = model else {
        return Vec::new();
    };
    // The available map (TS `new Map` keyed by model value): discovered
    // models in discovery order, the current model always present (an
    // auth-revoked or undiscovered current model stays selectable).
    let mut available: Vec<(String, PickerModel)> = Vec::new();
    let upsert = |available: &mut Vec<(String, PickerModel)>, value: String, entry: PickerModel| {
        match available.iter_mut().find(|(key, _)| *key == value) {
            Some(slot) => slot.1 = entry,
            None => available.push((value, entry)),
        }
    };
    for candidate in models {
        let value = model_value(&candidate.provider, &candidate.id);
        upsert(&mut available, value, PickerModel::from_model(candidate));
    }
    upsert(
        &mut available,
        model_value(&model.provider, &model.id),
        model.clone(),
    );
    let mut options = vec![SessionConfigOption {
        id: "model".to_string(),
        name: "Model".to_string(),
        kind: "select",
        category: "model".to_string(),
        current_value: model_value(&model.provider, &model.id),
        options: available
            .iter()
            .map(|(value, model)| SessionConfigSelectOption {
                value: value.clone(),
                name: format!("{} ({})", model.name, model.provider),
            })
            .collect(),
    }];
    if model.reasoning && !available_levels.is_empty() {
        options.push(SessionConfigOption {
            id: "thought_level".to_string(),
            name: "Reasoning effort".to_string(),
            kind: "select",
            category: "thought_level".to_string(),
            current_value: thinking_level.to_string(),
            options: available_levels
                .iter()
                .map(|level| SessionConfigSelectOption {
                    value: level.clone(),
                    name: level.clone(),
                })
                .collect(),
        });
    }
    options
}

/// Serialize the options for a response payload (`configOptions`).
pub fn config_options_value(options: &[SessionConfigOption]) -> Value {
    serde_json::json!({ "configOptions": options })
}

/// Publish the options as a `config_option_update` when they actually
/// changed (TS `refreshConfig`'s JSON-compare gate), stamping the new
/// set as the published state either way. Connection-scoped: the update
/// rides origin turn 0, exactly like the TS publish call.
pub async fn publish_config_options(
    producer: &Arc<UpdateProducer>,
    published: &tokio::sync::Mutex<Vec<SessionConfigOption>>,
    options: Vec<SessionConfigOption>,
) {
    let changed = {
        let mut published = published.lock().await;
        if *published == options {
            false
        } else {
            *published = options.clone();
            true
        }
    };
    if !changed {
        return;
    }
    let update = AcpSessionUpdate::ConfigOptionUpdate {
        config_options: options,
    };
    let _ = producer
        .publish(&update, 0, super::meta::PrimeAgentEventPhase::Event, None)
        .await;
}

/// The in-process transport's model discovery: the registry the CLI
/// composition resolved against (auth storage + `models.json`, with the
/// private-authorization cache adopted), reading the auth-configured
/// available models (the TS `refreshAvailableModels` seam).
pub(crate) fn acp_model_registry(agent_dir: &Path) -> pa_core::models::ModelRegistry {
    let auth = pa_core::auth::AuthStorage::create(agent_dir);
    let mut registry = pa_core::models::ModelRegistry::create(auth, agent_dir.join("models.json"));
    registry.load_private_authorization_from_cache();
    registry
}

/// The in-process transport's discovery result (TS
/// `getAvailableModels`): `Err` carries the discovery failure the
/// caller reports as "unavailable, try again later".
pub(crate) fn discover_available_models(agent_dir: &Path) -> anyhow::Result<Vec<Model>> {
    Ok(acp_model_registry(agent_dir)
        .get_available()
        .into_iter()
        .cloned()
        .collect())
}

/// The switchable provider target the in-process session's stream reads
/// per call: the type the composition passes in so a picker model switch
/// swaps the live target (TS `setModel`'s stream re-registration).
pub type ProviderTargetSlot =
    Arc<std::sync::RwLock<Option<pa_core::session_engine::provider_adapter::ProviderTarget>>>;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(provider: &str, id: &str, name: &str, reasoning: bool) -> Model {
        Model {
            id: id.to_string(),
            name: name.to_string(),
            api: "faux".to_string(),
            provider: provider.to_string(),
            base_url: "http://localhost:0".to_string(),
            reasoning,
            thinking_level_map: None,
            input: vec![pa_types::ai::ModelInput::Text],
            cost: pa_types::ai::ModelCost {
                input: pa_types::JsNumber::from(0.0),
                output: pa_types::JsNumber::from(0.0),
                cache_read: pa_types::JsNumber::from(0.0),
                cache_write: pa_types::JsNumber::from(0.0),
            },
            context_window: 128_000,
            max_tokens: 4_096,
            featured: None,
            headers: None,
            compat: None,
        }
    }

    fn levels(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn model_value_is_the_serialized_pair() {
        // JSON.stringify shape, byte-identical: `["provider","model"]`.
        assert_eq!(model_value("faux", "faux-1"), r#"["faux","faux-1"]"#);
    }

    #[test]
    fn no_model_yields_no_options() {
        assert!(session_config_options(None, "medium", &levels(&["off"]), &[]).is_empty());
    }

    #[test]
    fn model_option_lists_discovered_and_current_models() {
        let current = PickerModel::from_model(&model("faux", "faux-1", "Faux Model", true));
        let models = vec![
            model("faux", "plain", "Plain", false),
            model("other", "m2", "M Two", false),
        ];
        let options = session_config_options(
            Some(&current),
            "medium",
            &levels(&["off", "medium", "high"]),
            &models,
        );
        assert_eq!(options.len(), 2);
        let model_option = &options[0];
        assert_eq!(model_option.id, "model");
        assert_eq!(model_option.kind, "select");
        assert_eq!(model_option.category, "model");
        assert_eq!(model_option.current_value, model_value("faux", "faux-1"));
        // Discovery order, the current model appended when undiscovered.
        let values: Vec<&str> = model_option
            .options
            .iter()
            .map(|option| option.value.as_str())
            .collect();
        assert_eq!(
            values,
            vec![
                model_value("faux", "plain").as_str(),
                model_value("other", "m2").as_str(),
                model_value("faux", "faux-1").as_str(),
            ]
        );
        assert_eq!(model_option.options[0].name, "Plain (faux)");
        // The effort option follows the current model's levels.
        let effort = &options[1];
        assert_eq!(effort.id, "thought_level");
        assert_eq!(effort.name, "Reasoning effort");
        assert_eq!(effort.category, "thought_level");
        assert_eq!(effort.current_value, "medium");
        assert_eq!(
            effort
                .options
                .iter()
                .map(|o| o.value.as_str())
                .collect::<Vec<_>>(),
            vec!["off", "medium", "high"]
        );
    }

    #[test]
    fn duplicate_values_collapse_and_the_current_model_wins_its_slot() {
        let current = PickerModel::from_model(&model("faux", "shared", "Live Name", false));
        // A discovered model with the same (provider, id): the current
        // model replaces the discovered entry in place (TS `Map.set`).
        let models = vec![model("faux", "shared", "Discovered Name", false)];
        let options =
            session_config_options(Some(current.clone()), "off", &levels(&["off"]), &models);
        assert_eq!(options[0].options.len(), 1);
        assert_eq!(options[0].options[0].name, "Live Name (faux)");
        // Non-reasoning current model: no effort option.
        assert_eq!(options.len(), 1);
    }

    #[test]
    fn connection_state_metadata_parses() {
        let parsed = PickerModel::from_connection_state(&json!({
            "id": "faux-1", "name": "Faux Model", "provider": "faux", "reasoning": true
        }))
        .expect("metadata parses");
        assert_eq!(parsed.id, "faux-1");
        assert!(parsed.reasoning);
        assert!(PickerModel::from_connection_state(&json!({ "id": "x" })).is_none());
    }

    #[test]
    fn response_value_carries_config_options() {
        let current = PickerModel::from_model(&model("faux", "faux-1", "Faux Model", false));
        let options = session_config_options(Some(current), "off", &[], &[]);
        let value = config_options_value(&options);
        assert_eq!(value["configOptions"][0]["id"], "model");
        assert_eq!(
            value["configOptions"][0]["currentValue"],
            r#"["faux","faux-1"]"#
        );
    }
}
