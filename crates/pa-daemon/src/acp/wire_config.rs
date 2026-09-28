//! The daemon-attached picker machinery (the TS #2455 port's wire side):
//! the hosted session's picker state, the `session/set_config_option`
//! handler over the worker's own wire commands (`get_connection_state`,
//! `get_available_models`, `set_model`, `set_thinking_level`), and the
//! refresh that republishes `config_option_update` on change.
//!
//! The wire-shape builders live in [`super::config_options`]; this module
//! owns the wire command flow and the hosted session's serialized config
//! queue (TS `enqueueConfig`/`configTask`).

use std::sync::Arc;

use serde_json::{json, Map, Value};
use tokio::sync::Mutex;

use super::config_options::{
    config_options_value, model_value, publish_config_options, session_config_options, PickerModel,
    SessionConfigOption,
};
use super::daemon::{DaemonAcpState, DaemonLink, REQUEST_TIMEOUT_MS, TURN_TIMEOUT_MS};
use super::jsonrpc;
use super::producer::{self, UpdateProducer};
use super::types;
use pa_types::daemon::DaemonCommand;

/// The hosted session's picker state: the published options, the
/// discovered models, and the serialized queue every config operation
/// runs through (TS `enqueueConfig`/`configTask`).
pub(crate) struct HostedConfig {
    pub(crate) queue: tokio::sync::Mutex<()>,
    pub(crate) published: tokio::sync::Mutex<Vec<SessionConfigOption>>,
    pub(crate) models: tokio::sync::Mutex<Vec<pa_types::ai::Model>>,
}

/// `session/set_config_option`: apply one picker selection through the
/// worker's wire commands and answer the refreshed options (TS #2455).
/// Config work is serialized through the session's queue, so selections
/// and the event-driven refreshes observe one another in arrival order.
pub(super) async fn handle_set_config_option(
    id: Value,
    params: Value,
    link: &Arc<DaemonLink>,
    state: &Arc<Mutex<DaemonAcpState>>,
    tx: producer::FrameSink,
) {
    let params = types::SetConfigOptionParams::parse(&params);
    // The session resolves before the queue (TS reads `session?.id`).
    let resolved = {
        let guard = state.lock().await;
        guard
            .session
            .as_ref()
            .filter(|hosted| hosted.acp_session_id == params.session_id)
            .map(|hosted| {
                (
                    hosted.daemon_active_session_id.clone(),
                    Arc::clone(&hosted.config),
                    Arc::clone(&hosted.producer),
                )
            })
    };
    let Some((daemon_session_id, config, producer)) = resolved else {
        let _ = tx.send(jsonrpc::error_response(
            &id,
            jsonrpc::INVALID_PARAMS,
            "Invalid params",
            Some(&json!({ "reason": format!("Unknown ACP session: {}", params.session_id) })),
        ));
        return;
    };
    // One config operation at a time (TS `enqueueConfig`).
    let _guard = config.queue.lock().await;
    // The queue can outlive the session: a close admitted between the
    // resolution and the run refuses further config work (TS
    // `sessionCloseInFlight`).
    let live = {
        let guard = state.lock().await;
        !guard.session_close_in_flight
            && guard
                .session
                .as_ref()
                .is_some_and(|hosted| hosted.acp_session_id == params.session_id)
    };
    let outcome = if live {
        apply_wire_config(
            link,
            &daemon_session_id,
            &config,
            &params.config_id,
            params.value.as_str(),
        )
        .await
    } else {
        Err(WireConfigError::invalid_params(
            "ACP session is closed or closing",
        ))
    };
    if let Err(error) = outcome {
        let _ = tx.send(error.response(&id));
        return;
    }
    // TS's `refreshConfig` rethrows a failed `getState`, so the enqueued
    // config task — and this response — reject: an applied selection must
    // not be acknowledged with the stale pre-change pickers.
    let options = match refresh_wire_config(link, &daemon_session_id, &config, &producer).await {
        Ok(options) => options,
        Err(error) => {
            let _ = tx.send(error.response(&id));
            return;
        }
    };
    let _ = tx.send(jsonrpc::response(&id, &config_options_value(&options)));
}

/// One failed wire config operation: the TS handler's `RequestError`
/// shapes.
pub(super) enum WireConfigError {
    InvalidParams(String),
    Internal(String),
}

impl WireConfigError {
    fn invalid_params(reason: impl Into<String>) -> WireConfigError {
        WireConfigError::InvalidParams(reason.into())
    }

    fn internal(details: impl Into<String>) -> WireConfigError {
        WireConfigError::Internal(details.into())
    }

    /// The JSON-RPC error frame (the TS `invalidParams` data shape).
    fn response(self, id: &Value) -> Value {
        match self {
            WireConfigError::InvalidParams(reason) => jsonrpc::error_response(
                &id,
                jsonrpc::INVALID_PARAMS,
                "Invalid params",
                Some(&json!({ "reason": reason })),
            ),
            WireConfigError::Internal(details) => jsonrpc::error_response(
                &id,
                jsonrpc::INTERNAL_ERROR,
                "Internal error",
                Some(&json!({ "details": details })),
            ),
        }
    }
}

/// Apply one selection (TS `session/set_config_option`'s handler body):
/// validate against the worker's live state, apply through the worker's
/// `set_model` / `set_thinking_level` commands.
async fn apply_wire_config(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
    config: &Arc<HostedConfig>,
    config_id: &str,
    value: Option<&str>,
) -> Result<(), WireConfigError> {
    match (config_id, value) {
        ("model", Some(value)) => {
            let state = fetch_connection_state(link, daemon_session_id).await;
            let current = state
                .as_ref()
                .and_then(|state| PickerModel::from_connection_state(&state["model"]));
            if current
                .as_ref()
                .map(|model| model_value(&model.provider, &model.id))
                .as_deref()
                == Some(value)
            {
                // The current model re-selected: the caller refreshes
                // without discovery (a resync during a discovery outage
                // still answers).
                return Ok(());
            }
            let models = fetch_available_models(link, daemon_session_id)
                .await
                .map_err(|_| {
                    WireConfigError::invalid_params(
                        "Model discovery is unavailable; try again later",
                    )
                })?;
            let model = models
                .iter()
                .find(|model| model_value(&model.provider, &model.id) == value)
                .cloned()
                .ok_or_else(|| {
                    WireConfigError::invalid_params(format!("Unavailable model: {value}"))
                })?;
            let response = link
                .request(
                    DaemonCommand::SetModel {
                        id: None,
                        active_session_id: daemon_session_id.to_string(),
                        provider: model.provider.clone(),
                        model_id: model.id.clone(),
                        rest: Map::default(),
                    },
                    TURN_TIMEOUT_MS,
                )
                .await
                .map_err(|error| WireConfigError::internal(error.to_string()))?;
            if !response.success {
                return Err(WireConfigError::internal(
                    response
                        .error
                        .unwrap_or_else(|| "the model switch failed".to_string()),
                ));
            }
            *config.models.lock().await = models;
            Ok(())
        }
        ("thought_level", Some(value)) => {
            // A failed state fetch is the request's own internal error,
            // never a verdict on the client's value (TS's handler
            // surfaces a failed `getState`; the refresh does the same).
            let Some(state) = fetch_connection_state(link, daemon_session_id).await else {
                return Err(WireConfigError::internal(
                    "the worker's live state could not be read; try again",
                ));
            };
            // The levels list is part of the state's contract (the
            // worker always answers it); its absence or a malformed
            // shape is the same unreadable-state error, not an empty
            // list the gate would blame the selection for.
            let levels: Vec<String> = match state.get("availableThinkingLevels") {
                Some(levels) => serde_json::from_value(levels.clone()).map_err(|_| {
                    WireConfigError::internal(
                        "the worker's state did not answer the supported levels; try again",
                    )
                })?,
                None => {
                    return Err(WireConfigError::internal(
                        "the worker's state did not answer the supported levels; try again",
                    ))
                }
            };
            // The worker's levels are #2858's map-driven capability
            // (`get_supported_thinking_levels` over the resolved model):
            // a route with an addressable thinking-level map advertises
            // its levels even when the coarse `reasoning` flag is false,
            // so the flag must not veto a selection the map offers. A
            // `["off"]`-only (or empty) list is the no-surface shape.
            let supported = levels.iter().any(|level| level != "off")
                && levels.iter().any(|level| level == value);
            if !supported {
                return Err(WireConfigError::invalid_params(format!(
                    "Unsupported reasoning effort: {value}"
                )));
            }
            let response = link
                .request(
                    DaemonCommand::SetThinkingLevel {
                        id: None,
                        active_session_id: daemon_session_id.to_string(),
                        level: value.to_string(),
                        rest: Map::default(),
                    },
                    TURN_TIMEOUT_MS,
                )
                .await
                .map_err(|error| WireConfigError::internal(error.to_string()))?;
            if !response.success {
                return Err(WireConfigError::internal(
                    response
                        .error
                        .unwrap_or_else(|| "the thinking level switch failed".to_string()),
                ));
            }
            Ok(())
        }
        _ => Err(WireConfigError::invalid_params(format!(
            "Invalid configuration option: {config_id}"
        ))),
    }
}

/// Fetch the worker's live connection state (TS `getState`): the model
/// metadata, the effective thinking level, and the supported levels.
pub(super) async fn fetch_connection_state(
    link: &Arc<DaemonLink>,
    active_session_id: &str,
) -> Option<Value> {
    let response = link
        .request(
            DaemonCommand::GetConnectionState {
                id: None,
                active_session_id: active_session_id.to_string(),
                rest: Map::default(),
            },
            REQUEST_TIMEOUT_MS,
        )
        .await
        .ok()?;
    if !response.success {
        return None;
    }
    response.data
}

/// Fetch the worker's available models (TS `getAvailableModels`).
pub(super) async fn fetch_available_models(
    link: &Arc<DaemonLink>,
    active_session_id: &str,
) -> anyhow::Result<Vec<pa_types::ai::Model>> {
    let response = link
        .request(
            DaemonCommand::GetAvailableModels {
                id: None,
                active_session_id: active_session_id.to_string(),
                rest: Map::default(),
            },
            REQUEST_TIMEOUT_MS,
        )
        .await?;
    if !response.success {
        anyhow::bail!(response
            .error
            .unwrap_or_else(|| "model discovery failed".to_string()));
    }
    let models = response
        .data
        .and_then(|data| data.get("models").cloned())
        .unwrap_or(Value::Null);
    Ok(serde_json::from_value(models).unwrap_or_default())
}

/// Build the pickers from one connection state (the shared computation's
/// wire-side input adapter).
pub(super) fn picker_options_from_state(
    state: Option<&Value>,
    models: &[pa_types::ai::Model],
) -> Vec<SessionConfigOption> {
    let Some(state) = state else {
        return Vec::new();
    };
    let model = PickerModel::from_connection_state(&state["model"]);
    let thinking_level = state
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .unwrap_or("off")
        .to_string();
    let levels: Vec<String> = state
        .get("availableThinkingLevels")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    session_config_options(model, &thinking_level, &levels, models)
}

/// Recompute the options from the worker's live state and publish the
/// change (TS `refreshConfig`). A failed state fetch rejects (TS's
/// refresh rethrows `getState`'s failure): the published set stays
/// untouched — never clobbered with an empty list — and the caller
/// decides whether the error answers the request or is dropped like the
/// TS trigger site's `.catch(() => undefined)`.
pub(super) async fn refresh_wire_config(
    link: &Arc<DaemonLink>,
    daemon_session_id: &str,
    config: &Arc<HostedConfig>,
    producer: &Arc<UpdateProducer>,
) -> Result<Vec<SessionConfigOption>, WireConfigError> {
    let Some(state) = fetch_connection_state(link, daemon_session_id).await else {
        return Err(WireConfigError::internal(
            "the post-apply refresh failed: the worker's live state could not be read",
        ));
    };
    let options = picker_options_from_state(Some(&state), &config.models.lock().await);
    publish_config_options(producer, &config.published, options.clone()).await;
    Ok(options)
}
