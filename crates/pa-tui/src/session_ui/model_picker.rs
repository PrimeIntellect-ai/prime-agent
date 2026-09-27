//! The model-picker concern: the `/model` catalog's TTL-gated refresh
//! and landed-catalog fold, the picker's open/key handling, and the
//! model/thinking-level application paths.
use super::*;

/// How long a fetched model catalog stays fresh (TS
/// `MODEL_CATALOG_REFRESH_TTL_MS`); a `/model` open past it refreshes
/// again in the background.
const MODEL_CATALOG_REFRESH_TTL: std::time::Duration = std::time::Duration::from_mins(1);

/// A landed `get_model_catalog` refresh: the full catalog and the providers
/// with configured auth (TS `AgentConnectionModelCatalog`).
pub(crate) struct ModelCatalogUpdate {
    pub models: Vec<pa_types::ai::Model>,
    pub configured_providers: std::collections::HashSet<String>,
}

impl SessionUi {
    /// The catalog entry for the current model (the `/fast` eligibility
    /// check needs the provider and api, not just the id).
    pub(super) fn current_model_entry(&self, view: &AgentView) -> Option<&pa_types::ai::Model> {
        let model_id = view.chrome.model_id.as_deref()?;
        self.model_catalog.iter().find(|model| model.id == model_id)
    }

    /// Open the `/model` picker over the cached catalog, its search
    /// prefilled with `search` (the Tab-intercepted partial; empty for the
    /// bare command). A refresh fires in the background when the snapshot
    /// is stale (forced when a search rides the open) and lands into the
    /// open picker.
    pub(super) async fn open_model_picker(
        &mut self,
        view: &mut AgentView,
        search: &str,
    ) -> Result<()> {
        let current = self.current_model(view);
        let thinking_level = self
            .picker_initial_thinking_level(current.as_ref(), view)
            .await;
        let options = ModelPickerOptions {
            models: self.model_catalog.clone(),
            current,
            configured_providers: self.model_configured_providers.clone(),
            recent_models: self.model_recent_models.clone(),
            thinking_level,
            viewport_rows: picker_viewport_rows(view.terminal_rows()),
        };
        // TS `handleModelCommand` always opens the menu (an empty catalog
        // renders the empty panel).
        let crate::model_picker::ModelCommandOutcome::Open(picker) =
            ModelPicker::open(options, search);
        view.model_picker = Some(*picker);
        // TS `refreshModels(initialModelSearch !== undefined)`.
        let force = !search.trim().is_empty();
        if self.model_refresh_due(force) {
            self.spawn_model_catalog_refresh();
        }
        Ok(())
    }

    /// The tray override label (TS `getTrayOverrideLabel`): the Ctrl+C
    /// exit hint while armed, else — while the agent streams and a draft
    /// sits in the editor — the streaming follow-up hint
    /// (`<followUp> to queue message`). The inline pickers never reach
    /// this from the key path (they own the whole dispatch before the
    /// editor, TS `isInlinePickerOpen`), and the dock render skips the
    /// tray while one is mounted.
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

    /// One key press while the `/model` picker is open: Esc/Ctrl+C close
    /// it without applying; Enter applies the selection.
    pub(super) async fn handle_model_picker_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The picker consumes Ctrl+C (close, not exit): report the handled
        // press so the force-quit guard can disarm once the whole pair was
        // consumed with TS semantics.
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let action = view
            .model_picker
            .as_mut()
            .map(|picker| picker.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(ModelPickerAction::None) | None => {}
            Some(ModelPickerAction::Cancel) => {
                view.model_picker = None;
                self.picker_restored_draft = false;
                self.dirty = true;
            }
            Some(ModelPickerAction::Apply(applied)) => {
                view.model_picker = None;
                // The Tab path leaves the typed `/model <partial>` behind in
                // the editor; the command path's submission already drained
                // it. Applying fulfills the command either way, so the
                // editor clears (a Cancel keeps the partial for editing) —
                // except the browse-restore path, where the editor holds the
                // user's restored draft, not the partial: the pick fulfills
                // the command and the draft stays.
                if self.picker_restored_draft {
                    self.picker_restored_draft = false;
                } else {
                    view.editor.set_text("");
                }
                // The daemon is the source of truth (TS
                // `ensureModelProviderConfigured`'s client gate rides the
                // connection's own configured set; the local snapshot can
                // lag an external credential change, so the switch is
                // sent first and the typed refusal routes the sign-in
                // flow).
                match self
                    .try_set_model(&applied.provider, &applied.model_id, view)
                    .await
                {
                    SetModelOutcome::Switched => {
                        // A user-edited effort applies after the model
                        // switch (TS `completeModelSelection`: `setModel`,
                        // then `applyThinkingLevel` — the level row only
                        // on success).
                        if let Some(level) = &applied.effort {
                            self.apply_thinking_level(level, view).await;
                        }
                    }
                    // The typed refusal: the model resolved but its
                    // provider is not signed in — the selection routes to
                    // the provider's sign-in flow and applies after the
                    // login lands.
                    SetModelOutcome::NeedsSignIn => {
                        self.begin_model_sign_in(&applied, view).await;
                    }
                    SetModelOutcome::Failed => {}
                }
            }
        }
        self.update_fast_filter(view);
        Ok(())
    }

    /// The session's current model, matched against the picker catalog (the
    /// daemon state reports the id; the catalog entry supplies the
    /// provider).
    fn current_model(&self, view: &AgentView) -> Option<CurrentModel> {
        let model_id = view.chrome.model_id.as_deref()?;
        let model = self
            .model_catalog
            .iter()
            .find(|model| model.id == model_id)?;
        Some(CurrentModel {
            provider: model.provider.clone(),
            model_id: model.id.clone(),
        })
    }

    /// Fire a background `get_model_catalog` refresh (TS
    /// `getModelSelectorRefreshPromise` + `getConnectionAvailableModels`):
    /// the response lands through the run loop's channel, and failures
    /// leave the current snapshot alone.
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
                // TS startup fetches fail silently (`getModelCandidates`
                // catches); the menu-open refresh surfaces the error only
                // while the menu is open, and the picker catalogs stay as
                // they are.
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

    /// Whether the catalog refresh is due (TS `getModelSelectorRefreshPromise`:
    /// forced, never fetched, or older than the TTL).
    pub(crate) fn model_refresh_due(&self, force: bool) -> bool {
        force
            || match self.models_fetched_at {
                None => true,
                Some(fetched) => fetched.elapsed() > MODEL_CATALOG_REFRESH_TTL,
            }
    }

    /// Fold a landed catalog refresh into the session and any open picker
    /// (TS `applyConnectionModelCatalog` + the menu's `updateModels`).
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
        self.update_fast_filter(view);
        self.dirty = true;
    }

    /// The picker's effort seed (TS `showConfigurationMenu`'s `thinkingLevel`
    /// option): the session's live level for a reasoning current model,
    /// else the settings default (`"medium"` when unset).
    async fn picker_initial_thinking_level(
        &mut self,
        current: Option<&CurrentModel>,
        view: &mut AgentView,
    ) -> Option<pa_types::ai::ModelThinkingLevel> {
        let reasoning = current.and_then(|current| {
            self.model_catalog
                .iter()
                .find(|model| model.provider == current.provider && model.id == current.model_id)
                .map(|model| model.reasoning)
        });
        if reasoning == Some(true) {
            let level = self
                .connection_state(view)
                .await
                .as_ref()
                .and_then(|state| state.get("thinkingLevel"))
                .and_then(Value::as_str)
                .and_then(pa_types::ai::thinking_level_from_str);
            return level;
        }
        self.default_thinking_level
            .as_deref()
            .and_then(pa_types::ai::thinking_level_from_str)
            .or(Some(pa_types::ai::ModelThinkingLevel::Medium))
    }

    /// Apply a picked model (TS `applySelectedModel` + the
    /// `completeModelSelection` status row): the daemon `set_model` command
    /// switches the live session — the agent, the provider target, and the
    /// session's settings default follow — then the client refreshes its
    /// model label and records the `Model: <id>` status row. The typed
    /// provider-unauthenticated refusal is the sign-in route (`NeedsSignIn`);
    /// every other failure surfaces as the error note.
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
                // The create path's runtime config carries the picked model,
                // so `/new` sessions start on it too (TS settings default).
                self.model_selection.provider = Some(provider.to_string());
                self.model_selection.model = Some(model_id.to_string());
                self.refresh_model_label(model_id, view).await;
                self.note(&format!("Model: {model_id}"), view);
                SetModelOutcome::Switched
            }
            Err(error) => {
                if crate::daemon_client::rejected_provider_unauthenticated(&error).is_some() {
                    return SetModelOutcome::NeedsSignIn;
                }
                // TS `showError`: the ⚠ Error row with the error tone.
                view.push_entry(ChatEntry::Status {
                    text: format!("\u{26a0} Error: {error:#}"),
                    kind: StatusKind::Error,
                });
                self.dirty = true;
                SetModelOutcome::Failed
            }
        }
    }

    /// The onboarding default-model apply (TS
    /// `prepareForModelSelectionAfterLogin`): the switch runs through the
    /// same `try_set_model` path the model picker uses. A refusal after
    /// the just-completed sign-in keeps the flow moving (TS's post-login
    /// "still unavailable" row — never a second sign-in route inside the
    /// onboarding pane), and every other failure already rendered its
    /// error row, so the caller never branches.
    pub(crate) async fn apply_model_selection(
        &mut self,
        provider: &str,
        model_id: &str,
        view: &mut AgentView,
    ) {
        match self.try_set_model(provider, model_id, view).await {
            // The switch recorded its own `Model: <id>` row; every other
            // failure already rendered the error row.
            SetModelOutcome::Switched | SetModelOutcome::Failed => {}
            SetModelOutcome::NeedsSignIn => {
                self.error_row(
                    &format!("Authentication completed, but {provider} is still unavailable."),
                    view,
                );
            }
        }
    }

    /// Apply a thinking level (TS `applyThinkingLevel`): the daemon
    /// `set_thinking_level` command switches the session's level (durable
    /// row and settings default included), then the client records the
    /// `Thinking level: <level>` status row and the tray's `model:effort`
    /// label follows the effective level.
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
                // The tray's effort suffix follows the level the switch
                // wrote: the daemon clamps the request (TS `setThinkingLevel`
                // emits the effective level; the Rust daemon answers no such
                // event, so the client re-reads the state `/effort` targets).
                // A failed read falls back to the requested level, never the
                // previous model's stale suffix.
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
                    // The switch succeeded; the state read did not. TS
                    // `applyThinkingLevel` patches the requested level into
                    // the connection state (the `thinking_level_changed`
                    // event corrects it later), so render the requested
                    // level — never the previous model's stale suffix.
                    Err(_) => {
                        view.chrome.thinking_suffix = pa_types::ai::thinking_level_from_str(level)
                            .map(|parsed| parsed.wire_name().to_string());
                    }
                }
                self.note(&format!("Thinking level: {level}"), view);
            }
            Err(error) => {
                // TS `showError`: the ⚠ Error row with the error tone.
                view.push_entry(ChatEntry::Status {
                    text: format!("\u{26a0} Error: {error:#}"),
                    kind: StatusKind::Error,
                });
                self.dirty = true;
            }
        }
    }

    /// Refresh the chrome model label after a live switch (TS
    /// `applySelectedModel` reads the state and patches the footer via
    /// `applyModelSwitchUiState`): the state's model wins, and a state
    /// that omits it falls back to the picked model (`state.model ??
    /// fallbackModel`) — the switch already succeeded, so the label must
    /// move even when the worker's summary cannot re-resolve the model.
    /// The tray's effort suffix follows the same read: a switch clamps
    /// the level (a model without the old level re-resolves it), and a
    /// model without reasoning renders the bare id.
    async fn refresh_model_label(&mut self, picked_model_id: &str, view: &mut AgentView) {
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
            let model_id = data
                .get("model")
                .and_then(|model| model.get("id"))
                .and_then(Value::as_str)
                .map_or_else(|| picked_model_id.to_string(), str::to_string);
            view.chrome.model_id = Some(model_id);
            view.chrome.thinking_suffix = crate::chrome::tray_thinking_suffix(&data);
        } else {
            // The picked model's effort is unknown when the read fails:
            // a stale suffix would pair the new model with the old
            // model's level (a combination TS never renders), so the
            // bare id wins.
            view.chrome.model_id = Some(picked_model_id.to_string());
            view.chrome.thinking_suffix = None;
        }
        self.dirty = true;
    }
}

/// The picker's viewport row budget (TS `showConfigurationMenu` passes
/// `min(20, rows - 3)` and `ConfigurationMenuComponent` subtracts one more
/// row for its hint).
pub(crate) fn picker_viewport_rows(terminal_rows: u16) -> usize {
    let terminal_rows = terminal_rows as usize;
    let menu_rows = 20.min(terminal_rows.saturating_sub(3).max(1));
    menu_rows.saturating_sub(1).max(1)
}
