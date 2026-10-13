//! The `/model` catalog's TTL-gated refresh and landed-catalog fold,
//! the picker's open/key handling, and the model/thinking-level application
//! paths.
use super::{
    key_event_to_id, streaming_tray_hint, AgentView, ChatEntry, CurrentModel, CycleDirection,
    DaemonCommand, Duration, KeyEvent, Map, ModelPicker, ModelPickerAction, ModelPickerOptions,
    Result, SessionUi, SetModelOutcome, StatusKind, UI_REQUEST_TIMEOUT_MS,
};
use serde_json::Value;

/// How long a fetched model catalog stays fresh; a `/model` open past it
/// refreshes again in the background.
const MODEL_CATALOG_REFRESH_TTL: std::time::Duration = std::time::Duration::from_mins(1);

/// A landed `get_model_catalog` refresh: the full catalog and the providers
/// with configured auth.
pub(crate) struct ModelCatalogUpdate {
    pub models: Vec<pa_types::ai::Model>,
    pub configured_providers: std::collections::HashSet<String>,
}

impl SessionUi {
    /// The catalog entry for the current model (the `/fast` eligibility check needs the provider
    /// and api): the provider-aware match of [`find_current_model_entry`].
    pub(super) fn current_model_entry(&self, view: &AgentView) -> Option<&pa_types::ai::Model> {
        let model_id = view.chrome.model_id.as_deref()?;
        find_current_model_entry(
            &self.model_catalog,
            view.chrome.model_provider.as_deref(),
            model_id,
        )
    }

    /// Open the `/model` picker over the cached catalog, its search prefilled with `search`. A
    /// refresh fires in the background when the snapshot is stale and lands into the open picker.
    pub(super) async fn open_model_picker(
        &mut self,
        view: &mut AgentView,
        search: &str,
    ) -> Result<()> {
        let current = self.current_model(view);
        // One connection-state read feeds both the thinking seed and the
        // scoped-model list.
        let state = self.connection_state(view).await;
        let thinking_level = self.picker_initial_thinking_level(current.as_ref(), state.as_ref());
        // The session's scoped list as `provider/id` keys; the picker resolves
        // them against its loaded catalog.
        let scoped_models: Vec<String> = state
            .as_ref()
            .and_then(|state| state.get("scopedModels"))
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| {
                        let model = entry.get("model")?;
                        Some(ModelPicker::model_key_provider(
                            model.get("provider")?.as_str()?,
                            model.get("id")?.as_str()?,
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let options = ModelPickerOptions {
            models: self.model_catalog.clone(),
            current,
            configured_providers: self.model_configured_providers.clone(),
            recent_models: self.model_recent_models.clone(),
            thinking_level,
            scoped_models,
            viewport_rows: picker_viewport_rows(view.terminal_rows()),
        };
        // Always open the menu (an empty catalog renders the empty panel).
        let crate::model_picker::ModelCommandOutcome::Open(picker) =
            ModelPicker::open(options, search);
        view.model_picker = Some(*picker);
        let force = !search.trim().is_empty();
        if self.model_refresh_due(force) {
            self.spawn_model_catalog_refresh();
        }
        Ok(())
    }

    /// The tray override label: the Ctrl+C exit hint while armed, else the streaming follow-up hint
    /// while the agent streams with a draft.
    pub(crate) fn tray_override(&self, view: &AgentView) -> Option<String> {
        if self.ctrl_c_hint_visible() {
            let key = self.keybindings.first_key("app.clear").map_or_else(
                || "Ctrl+C".to_string(),
                |key| crate::keybindings::format_key_text(&key),
            );
            return Some(format!("Press {key} again to exit"));
        }
        streaming_tray_hint(
            &self.keybindings,
            self.turn_active,
            &view.editor.get_expanded_text(),
        )
    }

    pub(super) async fn handle_model_picker_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The picker consumes Ctrl+C (close, not exit); report it so the
        // force-quit guard can disarm.
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let action = view
            .model_picker
            .as_mut()
            .map(|picker| picker.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(ModelPickerAction::None) | None => {}
            Some(ModelPickerAction::ScopeToggled { scoped }) => {
                // The picker stays mounted; only the adoption event rides out.
                if let Some(telemetry) = self.telemetry.clone() {
                    tokio::spawn(async move {
                        telemetry.scoped_models_used("toggle_scope", scoped).await;
                    });
                }
            }
            Some(ModelPickerAction::Cancel) => {
                view.model_picker = None;
                self.picker_restored_draft = false;
                self.dirty = true;
            }
            Some(ModelPickerAction::Apply(applied)) => {
                view.model_picker = None;
                // Applying fulfills the command either way, so the editor clears (a Cancel keeps
                // the partial), except the browse-restore path: the user's restored draft stays.
                if self.picker_restored_draft {
                    self.picker_restored_draft = false;
                } else {
                    view.editor.set_text("");
                }
                // The daemon is the source of truth: the local snapshot can lag an
                // external credential change, so the switch is sent first and the typed
                // refusal routes the sign-in flow.
                match self
                    .try_set_model(&applied.provider, &applied.model_id, view)
                    .await
                {
                    SetModelOutcome::Switched => {
                        // A user-edited effort applies after the switch, the level row only on
                        // success.
                        if let Some(level) = &applied.effort {
                            self.apply_thinking_level(level, view).await;
                        }
                    }
                    // The typed refusal: the selection routes to the sign-in flow and applies
                    // after the login lands.
                    SetModelOutcome::NeedsSignIn => {
                        self.begin_model_sign_in(&applied, view).await;
                    }
                    SetModelOutcome::Failed => {}
                }
            }
        }
        self.update_model_eligibility_filters(view);
        Ok(())
    }

    /// The session's current model, resolved with the same provider-aware match as
    /// [`Self::current_model_entry`].
    fn current_model(&self, view: &AgentView) -> Option<CurrentModel> {
        let model = self.current_model_entry(view)?;
        Some(CurrentModel {
            provider: model.provider.clone(),
            model_id: model.id.clone(),
        })
    }

    /// Fire a background `get_model_catalog` refresh: the response lands through the run loop's
    /// channel, and failures leave the current snapshot alone.
    pub(crate) fn spawn_model_catalog_refresh(&self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let updates = self.catalog_updates.clone();
        tokio::spawn(async move {
            let Ok(value) = client
                .request_ok(DaemonCommand::GetModelCatalog {
                    id: None,
                    active_session_id,
                    rest: Map::default(),
                })
                .await
            else {
                // Fail silently; the picker catalog stays as it is.
                return;
            };
            let models: Vec<pa_types::ai::Model> = value
                .get("models")
                .cloned()
                .and_then(|models| serde_json::from_value(models).ok())
                .unwrap_or_default();
            let configured_providers: std::collections::HashSet<String> = value
                .get("configuredProviders")
                .and_then(Value::as_array)
                .map(|providers| {
                    providers
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let _ = updates.send(ModelCatalogUpdate {
                models,
                configured_providers,
            });
        });
    }

    /// Whether the catalog refresh is due: forced, never fetched, or older
    /// than the TTL.
    pub(crate) fn model_refresh_due(&self, force: bool) -> bool {
        force
            || match self.models_fetched_at {
                None => true,
                Some(fetched) => fetched.elapsed() > MODEL_CATALOG_REFRESH_TTL,
            }
    }

    /// Fold a landed catalog refresh into the session and any open picker.
    pub(crate) fn apply_model_catalog(&mut self, update: ModelCatalogUpdate, view: &mut AgentView) {
        self.model_catalog = update.models;
        self.model_configured_providers = update.configured_providers;
        self.models_fetched_at = Some(std::time::Instant::now());
        let current = self.current_model(view);
        if let Some(picker) = view.model_picker.as_mut() {
            picker.update_state(
                current,
                self.model_catalog.clone(),
                self.model_configured_providers.clone(),
            );
        }
        self.update_model_eligibility_filters(view);
        self.dirty = true;
    }

    /// The picker's effort seed: the session's live level for a reasoning current model, else the
    /// settings default (`"medium"` when unset).
    fn picker_initial_thinking_level(
        &self,
        current: Option<&CurrentModel>,
        state: Option<&Value>,
    ) -> Option<pa_types::ai::ModelThinkingLevel> {
        let reasoning = current.and_then(|current| {
            self.model_catalog
                .iter()
                .find(|model| model.provider == current.provider && model.id == current.model_id)
                .map(|model| model.reasoning)
        });
        if reasoning == Some(true) {
            return state
                .and_then(|state| state.get("thinkingLevel"))
                .and_then(Value::as_str)
                .and_then(pa_types::ai::thinking_level_from_str);
        }
        self.default_thinking_level
            .as_deref()
            .and_then(pa_types::ai::thinking_level_from_str)
            .or(Some(pa_types::ai::ModelThinkingLevel::Medium))
    }

    /// Apply a picked model: the daemon `set_model` command switches the live session, then the
    /// client refreshes its model label and records the `Model: <id>` status row. The typed
    /// provider-unauthenticated refusal is the sign-in route; every other failure surfaces as the
    /// error note.
    pub(super) async fn try_set_model(
        &mut self,
        provider: &str,
        model_id: &str,
        view: &mut AgentView,
    ) -> SetModelOutcome {
        let switched = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::SetModel {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    provider: provider.to_string(),
                    model_id: model_id.to_string(),
                    rest: Map::default(),
                },
            )
            .await;
        match switched {
            Ok(_) => {
                // The create path's runtime config carries the picked model, so `/new`
                // sessions start on it too.
                self.model_selection.provider = Some(provider.to_string());
                self.model_selection.model = Some(model_id.to_string());
                self.refresh_model_label(provider, model_id, view).await;
                self.note(&format!("Model: {model_id}"), view);
                self.maybe_warn_anthropic_subscription_auth_if_subscribed(Some(provider), view)
                    .await;
                SetModelOutcome::Switched
            }
            Err(error) => {
                if crate::daemon_client::rejected_provider_unauthenticated(&error).is_some() {
                    return SetModelOutcome::NeedsSignIn;
                }
                // The ⚠ Error row with the error tone.
                view.push_entry(ChatEntry::Status {
                    text: format!("\u{26a0} Error: {error:#}"),
                    kind: StatusKind::Error,
                });
                self.dirty = true;
                SetModelOutcome::Failed
            }
        }
    }

    /// The onboarding default-model apply through the same `try_set_model` path. A refusal after
    /// the just-completed sign-in keeps the flow moving (never a second sign-in route).
    pub(crate) async fn apply_model_selection(
        &mut self,
        provider: &str,
        model_id: &str,
        view: &mut AgentView,
    ) {
        match self.try_set_model(provider, model_id, view).await {
            // The switch recorded its own row; failures already rendered theirs.
            SetModelOutcome::Switched | SetModelOutcome::Failed => {}
            SetModelOutcome::NeedsSignIn => {
                self.error_row(
                    &format!("Authentication completed, but {provider} is still unavailable."),
                    view,
                );
            }
        }
    }

    /// Cycle within the session's scoped list when one is set, else the available catalog. A `null`
    /// answer means "no other model"; the status names the provider (`Model: provider/id`, unlike
    /// the picker's `Model: <id>`).
    pub(super) async fn cycle_model(&mut self, direction: CycleDirection, view: &mut AgentView) {
        let cycled = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::CycleModel {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    direction: Some(direction),
                    rest: Map::default(),
                },
            )
            .await;
        match cycled {
            Ok(data) => {
                if data == Value::Null {
                    self.note("No other models available to cycle", view);
                    return;
                }
                let model = data.get("model");
                let provider = model
                    .and_then(|model| model.get("provider"))
                    .and_then(Value::as_str);
                let model_id = model
                    .and_then(|model| model.get("id"))
                    .and_then(Value::as_str);
                let Some((provider, model_id)) = provider.zip(model_id) else {
                    self.error_row("the cycle answer carried no model", view);
                    return;
                };
                let (provider, model_id) = (provider.to_string(), model_id.to_string());
                self.model_selection.provider = Some(provider.clone());
                self.model_selection.model = Some(model_id.clone());
                self.refresh_model_label(&provider, &model_id, view).await;
                self.note(&format!("Model: {provider}/{model_id}"), view);
                if let Some(telemetry) = self.telemetry.clone() {
                    // TS has no scoped-models telemetry: the adoption event reports the
                    // cycle's lane (the response's `isScoped`).
                    let action = match direction {
                        CycleDirection::Forward => "cycle_forward",
                        CycleDirection::Backward => "cycle_backward",
                    };
                    let scoped = data
                        .get("isScoped")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    tokio::spawn(async move {
                        telemetry.scoped_models_used(action, scoped).await;
                    });
                }
            }
            Err(error) => {
                self.error_row(&format!("{error:#}"), view);
            }
        }
        self.dirty = true;
    }

    /// Apply a thinking level: the daemon `set_thinking_level` command switches the session's
    /// level, then the client records the `Thinking level: <level>` status row.
    pub(super) async fn apply_thinking_level(&mut self, level: &str, view: &mut AgentView) {
        let switched = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::SetThinkingLevel {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    level: level.to_string(),
                    rest: Map::default(),
                },
            )
            .await;
        match switched {
            Ok(_) => {
                // The tray's effort suffix follows the level the switch wrote: the daemon clamps
                // the request and answers no such event, so the client re-reads the state.
                let state = self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::GetState {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            rest: Map::default(),
                        },
                    )
                    .await;
                match state {
                    Ok(data) => {
                        view.chrome.thinking_suffix = crate::chrome::tray_thinking_suffix(&data);
                    }
                    // The switch succeeded; the state read did not: render the requested
                    // level, never the previous model's stale suffix.
                    Err(_) => {
                        view.chrome.thinking_suffix = pa_types::ai::thinking_level_from_str(level)
                            .map(|parsed| parsed.wire_name().to_string());
                    }
                }
                self.note(&format!("Thinking level: {level}"), view);
            }
            Err(error) => {
                view.push_entry(ChatEntry::Status {
                    text: format!("\u{26a0} Error: {error:#}"),
                    kind: StatusKind::Error,
                });
                self.dirty = true;
            }
        }
    }

    /// Refresh the chrome model label after a live switch: the state's model wins, a state that
    /// omits it falls back to the picked model — the switch already succeeded, so the label must
    /// move; the provider follows the same ladder.
    async fn refresh_model_label(
        &mut self,
        picked_provider: &str,
        picked_model_id: &str,
        view: &mut AgentView,
    ) {
        let state = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetState {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await;
        if let Ok(data) = state {
            let model = data.get("model");
            let model_id = model
                .and_then(|model| model.get("id"))
                .and_then(Value::as_str)
                .map_or_else(|| picked_model_id.to_string(), str::to_string);
            let model_provider = model
                .and_then(|model| model.get("provider"))
                .and_then(Value::as_str)
                .map_or_else(|| picked_provider.to_string(), str::to_string);
            view.chrome.model_id = Some(model_id);
            view.chrome.model_provider = Some(model_provider);
            view.chrome.thinking_suffix = crate::chrome::tray_thinking_suffix(&data);
        } else {
            // The picked model's effort is unknown when the read fails: a stale suffix would pair
            // the new model with the old model's level, so the bare id wins.
            view.chrome.model_id = Some(picked_model_id.to_string());
            view.chrome.model_provider = Some(picked_provider.to_string());
            view.chrome.thinking_suffix = None;
        }
        self.dirty = true;
    }
}

/// The picker's viewport row budget: TS passes `min(20, rows - 3)` and its
/// menu subtracts one more row for the hint.
pub(crate) fn picker_viewport_rows(terminal_rows: u16) -> usize {
    let terminal_rows = terminal_rows as usize;
    let menu_rows = 20.min(terminal_rows.saturating_sub(3).max(1));
    menu_rows.saturating_sub(1).max(1)
}

/// The catalog entry the current model resolves to (provider plus id). ONLY the session's own
/// provider's entry matches — two providers can carry the same id. A missing provider (older
/// daemons) falls back to the id alone; a provider whose entry the catalog lacks resolves nothing.
fn find_current_model_entry<'a>(
    catalog: &'a [pa_types::ai::Model],
    provider: Option<&str>,
    model_id: &str,
) -> Option<&'a pa_types::ai::Model> {
    match provider {
        Some(provider) => catalog
            .iter()
            .find(|model| model.provider == provider && model.id == model_id),
        None => catalog.iter().find(|model| model.id == model_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(provider: &str, id: &str) -> pa_types::ai::Model {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": format!("{provider}/{id}"),
            "api": "openai-completions",
            "provider": provider,
            "baseUrl": "https://example.invalid/v1",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128_000,
            "maxTokens": 4096,
        }))
        .expect("mock model deserializes")
    }

    #[test]
    fn the_provider_disambiguates_duplicate_ids() {
        let catalog = vec![
            entry("openrouter", "z-ai/glm-5.3"),
            entry("prime-inference", "z-ai/glm-5.3"),
        ];
        let resolved = find_current_model_entry(&catalog, Some("prime-inference"), "z-ai/glm-5.3");
        assert_eq!(
            resolved.map(|model| model.provider.as_str()),
            Some("prime-inference"),
            "the session's own provider's entry wins, not the first same-id entry"
        );
    }

    #[test]
    fn a_known_provider_never_adopts_another_providers_same_id() {
        let catalog = vec![entry("openrouter", "z-ai/glm-5.3")];
        let resolved = find_current_model_entry(&catalog, Some("prime-inference"), "z-ai/glm-5.3");
        assert!(
            resolved.is_none(),
            "a missing own-provider entry must resolve no current model"
        );
    }

    #[test]
    fn a_missing_provider_falls_back_to_the_id() {
        let catalog = vec![
            entry("openrouter", "z-ai/glm-5.3"),
            entry("prime-inference", "z-ai/glm-5.3"),
        ];
        let resolved = find_current_model_entry(&catalog, None, "z-ai/glm-5.3");
        assert_eq!(
            resolved.map(|model| model.provider.as_str()),
            Some("openrouter"),
            "without a provider the id-only fallback keeps resolving the first match"
        );
    }
}
