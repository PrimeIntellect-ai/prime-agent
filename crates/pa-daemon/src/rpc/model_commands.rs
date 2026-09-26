//! The RPC command surface, part three: the model, thinking-level, and
//! queue-mode switches (TS `session.setModel`/`cycleModel`/
//! `refreshAvailableModels`/`setThinkingLevel`/`cycleThinkingLevel`/
//! `setSteeringMode`/`setFollowUpMode`), the shared selection tail
//! (`set_model`/`cycle_model`), and the available-models registry read.

use std::sync::Arc;

use serde_json::{json, Value};

use pa_core::session_engine::provider_adapter::{json_round_trip, ProviderTarget};
use pa_types::ai::{Model, ModelThinkingLevel};

use super::commands::RpcState;
use super::protocol::ResponseData;

/// The available-models registry over the mode's agent dir (the same
/// resolution `set_model` uses).
fn registry(state: &RpcState) -> pa_core::models::ModelRegistry {
    let auth = pa_core::auth::AuthStorage::create(&state.agent_dir);
    let mut registry =
        pa_core::models::ModelRegistry::create(auth, state.agent_dir.join("models.json"));
    registry.load_private_authorization_from_cache();
    registry
}

/// `set_model` (TS `session.setModel`): resolve through the available
/// catalog, swap the live provider target and the agent model, clamp the
/// thinking level, record the durable `model_change` row, and persist the
/// settings default.
pub(crate) async fn set_model(
    state: &Arc<RpcState>,
    payload: &Value,
) -> Result<ResponseData, String> {
    let _ops = state.model_ops.lock().await;
    let provider = payload
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| "set_model requires a provider".to_string())?;
    let model_id = payload
        .get("modelId")
        .and_then(Value::as_str)
        .ok_or_else(|| "set_model requires a modelId".to_string())?;
    let mut registry = registry(state);
    let model = registry
        .get_available()
        .into_iter()
        .find(|candidate| candidate.provider == provider && candidate.id == model_id)
        .cloned()
        .ok_or_else(|| format!("Model not found: {provider}/{model_id}"))?;
    apply_model_selection(state, &mut registry, &model).await?;
    Ok(ResponseData::Present(
        serde_json::to_value(&model).unwrap_or(Value::Null),
    ))
}

/// Apply one model selection: target swap, agent model, level clamp,
/// durable row, settings default (the shared `set_model`/`cycle_model`
/// tail).
async fn apply_model_selection(
    state: &Arc<RpcState>,
    registry: &mut pa_core::models::ModelRegistry,
    model: &Model,
) -> Result<(), String> {
    let resolved = registry.get_api_key_and_headers(model, model.headers.as_ref());
    // An unresolvable selection refuses the switch BEFORE anything moves:
    // the TS `setModel` path answers the sign-in/not-found error instead
    // of installing a target whose next turn fails on missing auth.
    if !resolved.ok {
        return Err(resolved
            .error
            .unwrap_or_else(|| "Model is not available: no credentials resolved".to_string()));
    }
    {
        // The write guard serializes the swap with every reader that
        // holds the handle (a prompt admission snapshots the engine
        // while holding the read guard): the provider target, agent
        // model, thinking clamp, and the handle's model/key facts move
        // as one step, so a concurrently admitted turn can never see
        // half of the selection.
        let mut handle = state.session.handle_mut().await;
        let provider_target = ProviderTarget {
            api_key: resolved.api_key.clone(),
            model: model.clone(),
            service_tier: None,
            headers: resolved.headers.clone(),
        };
        *handle
            .provider_target
            .write()
            .map_err(|error| error.to_string())? = Some(provider_target);
        let agent = handle.engine.session.agent();
        let agent_model: pa_agent::types::Model =
            json_round_trip(model).ok_or_else(|| "model conversion failed".to_string())?;
        agent.set_model(agent_model).await;
        // TS `_getThinkingLevelForModelSwitch`: keep the level when the
        // new model supports it, else clamp.
        let current = agent.state().await.thinking_level;
        let requested = pa_core::session_engine::provider_adapter::model_thinking_level(current);
        let clamped = pa_ai::models::clamp_thinking_level(model, requested);
        agent
            .set_thinking_level(
                pa_core::session_engine::provider_adapter::map_thinking_level(clamped),
            )
            .await;
        handle.model.clone_from(model);
        handle.api_key.clone_from(&resolved.api_key);
        // The turn-boundary model facts follow the switch: `model.info`
        // and the context window the usage estimate reads must report
        // the model the session NOW runs, not the assembly-time one.
        handle.engine.update_model_facts(model);
        let persistence = handle.engine.session.shared_persistence();
        let mut manager = persistence.lock().await;
        let _ = manager.append_model_change(&model.provider, &model.id);
    }
    let mut settings =
        pa_core::settings::SettingsManager::create(&state.settings_cwd().await, &state.agent_dir);
    settings
        .set_default_model_and_provider(model.provider.clone(), model.id.clone())
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// `cycle_model` (TS `session.cycleModel`, forward only on this wire):
/// cycle within the available catalog; fewer than two candidates answer
/// `null` like TS.
pub(crate) async fn cycle_model(state: &Arc<RpcState>) -> Result<ResponseData, String> {
    let _ops = state.model_ops.lock().await;
    let mut registry = registry(state);
    let available: Vec<Model> = registry.get_available().into_iter().cloned().collect();
    if available.len() <= 1 {
        return Ok(ResponseData::Present(Value::Null));
    }
    let current = state.session.handle().await;
    let current_provider = current.model.provider.clone();
    let current_id = current.model.id.clone();
    drop(current);
    // When the current model is absent from the catalog (an auth filter
    // removed it), the cycle lands on the FIRST available model — not
    // the one after it (TS `cycleModel` steps from the current when
    // present, and from the head otherwise).
    let index = match available
        .iter()
        .position(|model| model.provider == current_provider && model.id == current_id)
    {
        Some(index) => (index + 1) % available.len(),
        None => 0,
    };
    let next = available[index].clone();
    apply_model_selection(state, &mut registry, &next).await?;
    let level = {
        let handle = state.session.handle().await;
        let agent = handle.engine.session.agent();
        serde_json::to_value(agent.state().await.thinking_level).unwrap_or(json!("off"))
    };
    Ok(ResponseData::Present(json!({
        "model": next,
        "thinkingLevel": level,
        "isScoped": false,
    })))
}

/// `get_available_models` (TS `refreshAvailableModels`): the refreshed
/// available catalog.
pub(crate) async fn get_available_models(state: &Arc<RpcState>) -> Result<ResponseData, String> {
    let mut registry = registry(state);
    let models = registry.refresh_available_models().await;
    Ok(ResponseData::Present(json!({ "models": models })))
}

/// The valid thinking-level wire names (TS `ThinkingLevel`).
const THINKING_LEVELS: &[&str] = &["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// `set_thinking_level` (TS `session.setThinkingLevel`): clamp to what
/// the model supports, record the durable row on a change, and persist
/// the settings default.
pub(crate) async fn set_thinking_level(
    state: &Arc<RpcState>,
    payload: &Value,
) -> Result<ResponseData, String> {
    let _ops = state.model_ops.lock().await;
    let level = payload
        .get("level")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid thinking level: expected a string".to_string())?;
    let Some(parsed) = pa_ai::models::thinking_level_from_str(level) else {
        return Err(format!(
            "Invalid thinking level \"{level}\". Valid values: {}",
            THINKING_LEVELS.join(", ")
        ));
    };
    apply_thinking_level(state, parsed).await?;
    Ok(ResponseData::Absent)
}

/// Apply one thinking level (the shared `set`/`cycle` tail): the durable
/// row and the settings default ride an effective change, and the
/// `thinking_level_changed` session event follows (TS `setThinkingLevel`).
async fn apply_thinking_level(
    state: &Arc<RpcState>,
    level: ModelThinkingLevel,
) -> Result<(), String> {
    let (wire_level, changed) = {
        // The write guard orders concurrent level switches: the live
        // level, the durable row, and the settings default land in one
        // serial sequence instead of interleaving (the durable row must
        // match the live level on reload).
        let handle = state.session.handle_mut().await;
        let agent = handle.engine.session.agent();
        let model = handle.model.clone();
        let clamped = pa_ai::models::clamp_thinking_level(&model, level);
        let previous =
            serde_json::to_value(agent.state().await.thinking_level).unwrap_or(json!("off"));
        agent
            .set_thinking_level(
                pa_core::session_engine::provider_adapter::map_thinking_level(clamped),
            )
            .await;
        let wire_level =
            serde_json::to_value(agent.state().await.thinking_level).unwrap_or(json!("off"));
        let changed = wire_level != previous;
        if changed {
            let persistence = handle.engine.session.shared_persistence();
            let mut manager = persistence.lock().await;
            manager
                .append_thinking_level_change(wire_level.as_str().unwrap_or("off"))
                .map_err(|error| format!("{error:#}"))?;
            // TS persists the default when the model can think or the
            // level is a real reasoning request.
            if model.reasoning || clamped != ModelThinkingLevel::Off {
                let mut settings = pa_core::settings::SettingsManager::create(
                    &state.settings_cwd().await,
                    &state.agent_dir,
                );
                settings
                    .set_default_thinking_level(
                        pa_core::settings::ThinkingLevelSetting::from_model_level(clamped),
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        (wire_level, changed)
    };
    if changed {
        state
            .session
            .write_connection_output(json!({
                "type": "thinking_level_changed",
                "level": wire_level,
            }))
            .await;
    }
    Ok(())
}

/// `cycle_thinking_level` (TS `session.cycleThinkingLevel`): cycle the
/// supported levels; a model without reasoning answers `null`.
pub(crate) async fn cycle_thinking_level(state: &Arc<RpcState>) -> Result<ResponseData, String> {
    let _ops = state.model_ops.lock().await;
    let handle = state.session.handle().await;
    let model = handle.model.clone();
    let agent = handle.engine.session.agent();
    if !model.reasoning {
        return Ok(ResponseData::Present(Value::Null));
    }
    let levels = pa_ai::models::get_supported_thinking_levels(&model);
    if levels.is_empty() {
        return Ok(ResponseData::Present(Value::Null));
    }
    // The agent's live level, mapped onto the model's level domain (the
    // supported list lives there); the cycle steps within it.
    let current = pa_core::session_engine::provider_adapter::model_thinking_level(
        agent.state().await.thinking_level,
    );
    drop(handle);
    let next = match levels.iter().position(|level| *level == current) {
        Some(index) => levels[(index + 1) % levels.len()],
        None => levels[0],
    };
    apply_thinking_level(state, next).await?;
    Ok(ResponseData::Present(json!({ "level": next.wire_name() })))
}

/// `set_steering_mode` / `set_follow_up_mode` (TS
/// `session.setSteeringMode`/`setFollowUpMode`).
pub(crate) async fn set_queue_mode(
    state: &Arc<RpcState>,
    payload: &Value,
    name: &str,
) -> Result<ResponseData, String> {
    let mode = payload
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{name} requires a mode"))?;
    let mode = match mode {
        "all" => pa_agent::agent::QueueMode::All,
        "one-at-a-time" => pa_agent::agent::QueueMode::OneAtATime,
        other => {
            return Err(format!(
                "Invalid queue mode \"{other}\". Valid values: all, one-at-a-time"
            ));
        }
    };
    let handle = state.session.handle().await;
    let agent = handle.engine.session.agent();
    if name == "set_steering_mode" {
        agent.set_steering_mode(mode);
    } else {
        agent.set_follow_up_mode(mode);
    }
    drop(handle);
    // The settings default follows the live mode (the daemon handlers
    // persist the same way): a later session/connection loads the
    // selected mode instead of reverting.
    let mut settings =
        pa_core::settings::SettingsManager::create(&state.settings_cwd().await, &state.agent_dir);
    let setting = match mode {
        pa_agent::agent::QueueMode::All => pa_core::settings::QueueModeSetting::All,
        pa_agent::agent::QueueMode::OneAtATime => pa_core::settings::QueueModeSetting::OneAtATime,
    };
    if name == "set_steering_mode" {
        settings
            .set_steering_mode(setting)
            .map_err(|error| error.to_string())?;
    } else {
        settings
            .set_follow_up_mode(setting)
            .map_err(|error| error.to_string())?;
    }
    Ok(ResponseData::Absent)
}
