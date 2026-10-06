//! The `/settings` menu and its row-apply/persist switches, the `/import`
//! confirm flow, and the fast/rlm-max-depth/reload command surface. The
//! fullscreen toggle is retired (the operator's 2026-09-28 ruling removed
//! the setting and the command).
use super::{
    key_event_to_id, AgentView, DaemonCommand, Duration, KeyEvent, Map, PathBuf, Result, SessionUi,
    StatusKind, Value, UI_REQUEST_TIMEOUT_MS,
};

/// The `/reload` task's report: the daemon reloaded the session's live
/// inputs, or the failure message.
pub(crate) type ReloadNote = Result<(), String>;

/// The question a pending confirm answers (callers await inline in TS;
/// the TUI loop parks the continuation instead).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PendingConfirm {
    /// `/import <path>`: replace the current session with the JSONL file.
    Import { path: String },
    /// The import's stored session cwd is gone: `Yes` retries with the
    /// fallback cwd.
    ImportCwdFallback { path: String, fallback_cwd: String },
    /// `/update`: `Yes` spawns the out-of-band installer run (the confirm
    /// guards the binary replacement, not the session).
    Update,
}

impl SessionUi {
    /// The shipped CHANGELOG.md path: the package directory (`PI_PACKAGE_DIR`
    /// wins, else the running executable's directory) plus `CHANGELOG.md`.
    pub(super) fn changelog_path() -> std::path::PathBuf {
        let package_dir = match std::env::var("PI_PACKAGE_DIR") {
            Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
                .unwrap_or_else(|| PathBuf::from(".")),
        };
        package_dir.join("CHANGELOG.md")
    }

    // Session import (/import)

    /// Parse the path, park the confirm, and let the panel answer it.
    pub(super) fn open_import_confirm(&mut self, command_text: &str, view: &mut AgentView) {
        let Some(input_path) = crate::export_share::path_command_argument(command_text, "/import")
        else {
            self.error_row("Usage: /import <path.jsonl>", view);
            return;
        };
        view.editor.set_text("");
        view.confirm = Some(crate::confirm::ConfirmPanel::yes_no(
            "Import session",
            &format!("Replace current session with {input_path}?"),
        ));
        self.pending_confirm = Some(PendingConfirm::Import { path: input_path });
        self.dirty = true;
    }

    /// One key press while the confirm panel owns the frame.
    pub(super) async fn handle_confirm_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        let action = {
            let Some(confirm) = view.confirm.as_mut() else {
                return Ok(());
            };
            let kb = view.editor.keybindings();
            confirm.handle_key(kb, &id)
        };
        match action {
            crate::confirm::ConfirmAction::None => {}
            crate::confirm::ConfirmAction::Cancel => {
                view.confirm = None;
                self.pending_confirm = None;
            }
            crate::confirm::ConfirmAction::Select(option) => {
                let pending = self.pending_confirm.take();
                view.confirm = None;
                if option == "Yes" {
                    match pending {
                        Some(PendingConfirm::Import { path }) => {
                            self.run_import(&path, None, view).await?;
                        }
                        Some(PendingConfirm::ImportCwdFallback { path, fallback_cwd }) => {
                            self.run_import(&path, Some(&fallback_cwd), view).await?;
                        }
                        Some(PendingConfirm::Update) => {
                            self.spawn_update(view);
                        }
                        None => {}
                    }
                }
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// The import request and its outcomes: the cancelled note, the typed
    /// error surfaces, and the successful rebuild + status.
    async fn run_import(
        &mut self,
        input_path: &str,
        cwd_override: Option<&str>,
        view: &mut AgentView,
    ) -> Result<()> {
        let response = self
            .client
            .request(DaemonCommand::ImportJsonl {
                id: None,
                active_session_id: self.active_session_id.clone(),
                input_path: input_path.to_string(),
                cwd_override: cwd_override.map(str::to_string),
                rest: Map::default(),
            })
            .await?;
        if !response.success {
            let error = response.error.unwrap_or_default();
            match response.error_info {
                Some(pa_types::daemon::DaemonErrorInfo::SessionImportFileNotFound {
                    file_path,
                }) => {
                    self.error_row(
                        &format!("Failed to import session: File not found: {file_path}"),
                        view,
                    );
                }
                Some(pa_types::daemon::DaemonErrorInfo::MissingSessionCwd { issue }) => {
                    // The confirm carries the issue's text; `Yes` retries with the fallback
                    // cwd as the override.
                    let session_cwd = issue
                        .get("sessionCwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let fallback_cwd = issue
                        .get("fallbackCwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    view.confirm = Some(crate::confirm::ConfirmPanel::yes_no(
                        "Session cwd not found",
                        &format!(
                            "cwd from session file does not exist\n{session_cwd}\n\ncontinue in current cwd\n{fallback_cwd}"
                        ),
                    ));
                    self.pending_confirm = Some(PendingConfirm::ImportCwdFallback {
                        path: input_path.to_string(),
                        fallback_cwd,
                    });
                    self.dirty = true;
                }
                _ => {
                    self.error_row(&format!("Failed to import session: {error}"), view);
                }
            }
            return Ok(());
        }
        if response
            .data
            .as_ref()
            .and_then(|data| data.get("cancelled"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            self.note("Import cancelled", view);
            return Ok(());
        }
        // The replacement's fresh branch renders from scratch, then the status row
        // lands.
        self.rebuild_transcript(view).await;
        self.refresh_stats().await;
        // The transcript rebuild ran before the refresh, so the refreshed context usage rides the
        // chrome through this tray rebuild — without it the tray keeps the pre-import usage until
        // the next settled turn.
        self.rebuild_tray(view);
        self.note(&format!("Session imported from: {input_path}"), view);
        Ok(())
    }

    // Settings (/settings)

    /// Read the daemon state and the settings seam, then mount the menu.
    pub(super) async fn open_settings_menu(&mut self, view: &mut AgentView) {
        let Some(state) = self.connection_state(view).await else {
            return;
        };
        let settings = self.client_settings.clone();
        let mut values = crate::settings_menu::SettingsCurrentValues {
            autocompact: state
                .get("autoCompactionEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            steering_mode: state
                .get("steeringMode")
                .and_then(Value::as_str)
                .unwrap_or("all")
                .to_string(),
            follow_up_mode: state
                .get("followUpMode")
                .and_then(Value::as_str)
                .unwrap_or("one-at-a-time")
                .to_string(),
            thinking_level: state
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .map(str::to_string),
            available_thinking_levels: state
                .get("availableThinkingLevels")
                .and_then(Value::as_array)
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            ..Default::default()
        };
        // A missing settings seam keeps the TS defaults.
        if let Some(settings) = &settings {
            values.show_images = settings.show_images();
            values.auto_resize_images = settings.image_auto_resize();
            values.block_images = settings.block_images();
            values.skill_commands = settings.enable_skill_commands();
            values.builtin_skills = settings.enable_builtin_skills();
            values.hardware_cursor = settings.show_hardware_cursor();
            values.editor_padding = settings.editor_padding_x();
            values.autocomplete_max_visible = settings.autocomplete_max_visible();
            values.clear_on_shrink = settings.clear_on_shrink();
            values.terminal_progress = settings.show_terminal_progress();
            values.idle_eviction_minutes = settings.idle_eviction_minutes();
            values.mermaid = settings.mermaid_rendering_mode();
            values.quiet_startup = settings.quiet_startup();
            values.tree_filter_mode = settings.tree_filter_mode();
            values.warnings_anthropic_extra_usage = settings.warnings_anthropic_extra_usage();
            values.theme = settings.theme().unwrap_or_else(|| "prime".to_string());
            // The tier row preselects the saved default instead of the struct default.
            values.default_service_tier = settings.default_service_tier();
        } else {
            values.show_images = true;
            values.auto_resize_images = true;
            values.skill_commands = true;
            values.builtin_skills = true;
            values.idle_eviction_minutes = "90".to_string();
            values.mermaid = "streaming".to_string();
            values.tree_filter_mode = "user-only".to_string();
            values.warnings_anthropic_extra_usage = true;
            values.theme = "prime".to_string();
            // No settings seam: the tier row reads "default", never a blank value.
            values.default_service_tier = "default".to_string();
        }
        // This surface ships the builtin themes.
        values.available_themes = pa_types::themes::BUILTIN_THEME_NAMES
            .iter()
            .map(ToString::to_string)
            .collect();
        let rows = crate::settings_menu::settings_menu_rows(&values);
        view.settings_menu = Some(crate::settings_menu::SettingsMenu::new(rows));
        self.track_menu_opened("settings", "command");
        self.dirty = true;
    }

    /// One key press while the settings menu is open.
    pub(super) async fn handle_settings_menu_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        let action = {
            let Some(menu) = view.settings_menu.as_mut() else {
                return Ok(());
            };
            menu.handle_key(&id, view.editor.keybindings())
        };
        match action {
            // No-op closes: a bare None and Esc inside a submenu keep the menu open.
            crate::settings_menu::SettingsMenuAction::None
            | crate::settings_menu::SettingsMenuAction::SubmenuClosed => {}
            crate::settings_menu::SettingsMenuAction::Cancel => {
                view.settings_menu = None;
            }
            crate::settings_menu::SettingsMenuAction::PreviewTheme { name } => {
                // Switch live without persisting.
                view.theme = crate::app::load_theme(&name);
            }
            crate::settings_menu::SettingsMenuAction::RestoreTheme { name } => {
                // Preview the row's theme back.
                view.theme = crate::app::load_theme(&name);
            }
            crate::settings_menu::SettingsMenuAction::Change { id, value } => {
                self.apply_settings_change(id, &value, view).await;
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// One settings row's change: daemon commands for session-owned switches,
    /// the settings seam for persisted preferences.
    async fn apply_settings_change(&mut self, id: &str, value: &str, view: &mut AgentView) {
        match id {
            "autocompact" => {
                self.daemon_switch(
                    DaemonCommand::SetAutoCompaction {
                        id: None,
                        active_session_id: self.active_session_id.clone(),
                        enabled: value == "true",
                        rest: Map::default(),
                    },
                    view,
                )
                .await;
            }
            "show-images" => {
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_show_images(value == "true") {
                        self.error_row(&format!("{error:#}"), view);
                        return;
                    }
                }
                self.show_images = value == "true";
                view.show_images = value == "true";
            }
            "auto-resize-images" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_image_auto_resize(enabled),
                    value,
                    view,
                );
            }
            "block-images" => {
                self.persist_bool_setting(
                    |settings, blocked| settings.set_block_images(blocked),
                    value,
                    view,
                );
            }
            "skill-commands" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_enable_skill_commands(enabled),
                    value,
                    view,
                );
                // The cached skill list re-applies under the new setting value (no daemon
                // round trip).
                let enabled = self
                    .client_settings
                    .as_ref()
                    .is_some_and(|settings| settings.enable_skill_commands());
                let skills = if enabled {
                    self.skill_commands_cache.clone()
                } else {
                    Vec::new()
                };
                view.editor.set_autocomplete_skill_commands(skills);
                self.dirty = true;
            }
            "builtin-skills" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_enable_builtin_skills(enabled),
                    value,
                    view,
                );
                // The toggle takes effect after a reload.
                let _ = self.handle_reload_command(view);
            }
            "show-hardware-cursor" => {
                // A failed persist changes nothing: the live flag flips only when the
                // setting actually persisted.
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_show_hardware_cursor(value == "true") {
                        self.error_row(&format!("{error:#}"), view);
                        return;
                    }
                }
                // The very next frame shows or hides the hardware cursor at the focused
                // caret.
                view.show_hardware_cursor = value == "true";
            }
            "editor-padding" => {
                if let Some(settings) = &self.client_settings {
                    if let Ok(padding) = value.parse::<u64>() {
                        if let Err(error) = settings.set_editor_padding_x(padding) {
                            self.error_row(&format!("{error:#}"), view);
                        }
                    }
                }
            }
            "autocomplete-max-visible" => {
                if let Some(settings) = &self.client_settings {
                    if let Ok(max_visible) = value.parse::<u64>() {
                        if let Err(error) = settings.set_autocomplete_max_visible(max_visible) {
                            self.error_row(&format!("{error:#}"), view);
                        }
                    }
                }
            }
            "clear-on-shrink" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_clear_on_shrink(enabled),
                    value,
                    view,
                );
            }
            "terminal-progress" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_show_terminal_progress(enabled),
                    value,
                    view,
                );
            }
            "idle-eviction-minutes" => {
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_idle_eviction_minutes(value) {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            "steering-mode" => {
                self.daemon_switch(
                    DaemonCommand::SetSteeringMode {
                        id: None,
                        active_session_id: self.active_session_id.clone(),
                        mode: serde_json::Value::String(value.to_string()),
                        rest: Map::default(),
                    },
                    view,
                )
                .await;
                // Refresh the steering-mode cache the queued-input event reads, so a
                // submission right after the switch reports the new mode.
                let _ = self.connection_state(view).await;
            }
            "follow-up-mode" => {
                self.daemon_switch(
                    DaemonCommand::SetFollowUpMode {
                        id: None,
                        active_session_id: self.active_session_id.clone(),
                        mode: serde_json::Value::String(value.to_string()),
                        rest: Map::default(),
                    },
                    view,
                )
                .await;
            }
            "transport" => {
                let Ok(transport) = serde_json::from_value::<pa_types::ai::Transport>(
                    serde_json::Value::String(value.to_string()),
                ) else {
                    return;
                };
                self.daemon_switch(
                    DaemonCommand::SetTransport {
                        id: None,
                        active_session_id: self.active_session_id.clone(),
                        transport,
                        rest: Map::default(),
                    },
                    view,
                )
                .await;
            }
            "default-service-tier" => {
                // Persist the default tier (new sessions start on it), then apply it to
                // the running session through the same daemon tier switch `/tier` uses.
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_default_service_tier(value) {
                        self.error_row(&format!("{error:#}"), view);
                        return;
                    }
                }
                let tier = match serde_json::from_value::<pa_types::ai::ServiceTier>(Value::String(
                    value.to_string(),
                )) {
                    Ok(tier) => tier,
                    Err(error) => {
                        self.error_row(&format!("{error:#}"), view);
                        return;
                    }
                };
                let switched = self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::SetServiceTier {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            service_tier: Some(tier),
                            rest: Map::default(),
                        },
                    )
                    .await;
                if let Err(error) = switched {
                    self.error_row(&format!("{error:#}"), view);
                    return;
                }
                // The status row reports what the session actually applied; a state read
                // that fails or omits the tier shows no success row.
                let Some(state) = self.connection_state(view).await else {
                    return;
                };
                let Some(applied) = state
                    .get("serviceTier")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                else {
                    return;
                };
                self.service_tier = Some(applied.clone());
                view.chrome.service_tier = Some(applied.clone());
                self.update_model_eligibility_filters(view);
                self.note(
                    &format!("Default service tier: {value} (session: {applied})"),
                    view,
                );
            }

            "mermaid-rendering" => {
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_mermaid_rendering_mode(value) {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            "quiet-startup" => {
                self.persist_bool_setting(
                    |settings, quiet| settings.set_quiet_startup(quiet),
                    value,
                    view,
                );
            }
            "tree-filter-mode" => {
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_tree_filter_mode(value) {
                        self.error_row(&format!("{error:#}"), view);
                        return;
                    }
                }
                // The `/tree` selector reads the live field.
                self.tree_filter_mode = crate::tree_list::filter_mode_from_str(value);
            }
            "warnings-anthropic-extra-usage" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_warnings_anthropic_extra_usage(enabled),
                    value,
                    view,
                );
            }
            "thinking" => {
                self.apply_thinking_level(value, view).await;
            }
            "theme" => {
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_theme(value) {
                        self.error_row(&format!("{error:#}"), view);
                        return;
                    }
                }
                view.theme = crate::app::load_theme(value);
            }
            other => {
                self.error_row(&format!("Unknown setting: {other}"), view);
            }
        }
    }

    /// Persist one boolean row through the settings seam, surfacing errors.
    fn persist_bool_setting(
        &mut self,
        set: impl FnOnce(&dyn crate::client_settings::ClientSettings, bool) -> anyhow::Result<()>,
        value: &str,
        view: &mut AgentView,
    ) {
        if let Some(settings) = &self.client_settings {
            if let Err(error) = set(settings.as_ref(), value == "true") {
                self.error_row(&format!("{error:#}"), view);
            }
        }
    }

    /// A session-switch daemon command: the result never blocks the menu.
    async fn daemon_switch(&mut self, command: DaemonCommand, view: &mut AgentView) {
        if let Err(error) = self
            .bounded_request(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), command)
            .await
        {
            self.error_row(&format!("{error:#}"), view);
        }
    }

    // Fast mode, depth, and reload (/fast, /rlm-max-depth, /reload)

    /// Toggle the priority service tier. TS serializes toggles through a queue; here the dispatch
    /// awaits to completion, so toggles cannot interleave.
    pub(super) async fn handle_fast_command(&mut self, view: &mut AgentView) {
        const UNAVAILABLE: &str = "Fast mode requires GPT-5.4, GPT-5.5, or GPT-5.6 with ChatGPT or OpenAI API key authentication";
        let eligible = self
            .current_model_entry(view)
            .is_some_and(pa_types::ai::supports_fast_mode);
        if !eligible {
            self.note(UNAVAILABLE, view);
            return;
        }
        // Read the current tier (priority = on) and flip it; the refresh after the
        // switch confirms the daemon's tier.
        let enabled = self.service_tier.as_deref() == Some("priority");
        let target = if enabled { "default" } else { "priority" };
        let tier = match serde_json::from_value::<pa_types::ai::ServiceTier>(
            serde_json::Value::String(target.to_string()),
        ) {
            Ok(tier) => tier,
            Err(error) => {
                self.error_row(&format!("{error:#}"), view);
                return;
            }
        };
        let switched = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::SetServiceTier {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    service_tier: Some(tier),
                    rest: Map::default(),
                },
            )
            .await;
        if let Err(error) = switched {
            self.error_row(&format!("{error:#}"), view);
            return;
        }
        let state = self.connection_state(view).await;
        if let Some(state) = state {
            if let Some(tier) = state.get("serviceTier").and_then(Value::as_str) {
                self.service_tier = Some(tier.to_string());
            }
        }
        // The tray badge and the `/tier` completions follow the applied tier.
        view.chrome.service_tier.clone_from(&self.service_tier);
        self.update_model_eligibility_filters(view);
        let on = self.service_tier.as_deref() == Some("priority");
        self.note(
            &format!("Fast mode: {}", if on { "on" } else { "off" }),
            view,
        );
    }

    /// A missing argument reports the depth and its source; `<int> [--global]`
    /// sets the per-chat depth immediately and optionally the global default.
    pub(super) async fn handle_rlm_max_depth_command(&mut self, view: &mut AgentView, args: &str) {
        let tokens: Vec<&str> = if args.is_empty() {
            Vec::new()
        } else {
            args.split_whitespace().collect()
        };
        if tokens.is_empty() {
            match self
                .bounded_request(
                    Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                    DaemonCommand::GetRlmMaxDepthStatus {
                        id: None,
                        active_session_id: self.active_session_id.clone(),
                        rest: Map::default(),
                    },
                )
                .await
            {
                Ok(data) => {
                    let depth = data.get("maxDepth").and_then(Value::as_u64).unwrap_or(0);
                    let source = data
                        .get("source")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    self.plain_row(&format!("RLM max depth: {depth} ({source})"), view);
                }
                Err(error) => self.error_row(&format!("{error:#}"), view),
            }
            return;
        }
        let global = tokens.get(1) == Some(&"--global");
        let valid = tokens.len() <= if global { 2 } else { 1 }
            && tokens[0].chars().all(|c| c.is_ascii_digit());
        if !valid {
            self.note_as(
                "Usage: /rlm-max-depth [<non-negative integer> [--global]]",
                StatusKind::Warning,
                view,
            );
            return;
        }
        let Ok(max_depth) = tokens[0].parse::<u64>() else {
            self.note_as(
                "RLM max depth must be a non-negative integer.",
                StatusKind::Warning,
                view,
            );
            return;
        };
        match self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::SetRlmMaxDepth {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    max_depth,
                    global: Some(global),
                    rest: Map::default(),
                },
            )
            .await
        {
            Ok(data) => {
                let saved = data
                    .get("globalSaved")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.plain_row(
                    &format!(
                        "RLM max depth set: {max_depth}{}",
                        if saved {
                            " and saved as global default"
                        } else {
                            ""
                        }
                    ),
                    view,
                );
                if let Some(error) = data.get("globalError").and_then(Value::as_str) {
                    self.error_row(
                        &format!("RLM max depth set for this chat, but the global default was not saved: {error}"),
                        view,
                    );
                }
            }
            Err(error) => self.error_row(&format!("{error:#}"), view),
        }
    }

    /// The Ctrl+O cycle saves the new level as the global `chatDetail` setting, so every later chat
    /// opens at it. A failed save lands only in the settings store's diagnostics.
    pub(crate) fn save_chat_detail(&self, view: &AgentView) {
        if let Some(settings) = &self.client_settings {
            let _ = settings.set_chat_detail(view.detail.wire_name());
        }
    }

    /// The reload box replaces the editor while the daemon reload runs; the
    /// run loop folds the outcome in when it lands.
    pub(super) fn handle_reload_command(&mut self, view: &mut AgentView) -> Result<()> {
        view.reload_box = Some("Reloading keybindings, skills, prompts, themes...".to_string());
        self.dirty = true;
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let notes = self.reload_notes.clone();
        let task = tokio::spawn(async move {
            let outcome = client
                .request_ok(DaemonCommand::Reload {
                    id: None,
                    active_session_id,
                    rest: Map::default(),
                })
                .await
                .map(|_| ())
                .map_err(|error| format!("{error:#}"));
            let _ = notes.send(outcome);
        });
        self.reload = Some(task);
        Ok(())
    }

    /// Drop the box, re-read the user keybindings and theme, refresh the model
    /// catalog, and surface the status row.
    pub(crate) async fn apply_reload_outcome(&mut self, outcome: ReloadNote, view: &mut AgentView) {
        self.reload = None;
        view.reload_box = None;
        match outcome {
            Ok(()) => {
                // The view rebuilds from the durable session store, so client status rows
                // drop exactly like the TS re-mount.
                self.rebuild_transcript(view).await;
                // The Rust editor consumes the keybinding set, so the reloaded manager
                // replaces it.
                let mut keybindings = view.editor.keybindings().clone();
                keybindings.reload();
                view.editor.set_keybindings(keybindings);
                // An unknown theme name keeps the current theme (the startup loader's
                // fallback).
                if let Some(settings) = &self.client_settings {
                    if let Some(name) = settings.theme() {
                        view.theme = crate::app::load_theme(&name);
                    }
                }
                // The model catalog re-fetch lands through the run loop's channel.
                self.spawn_model_catalog_refresh();
                // The same refresh re-fetches the slash-command catalog (skills may have
                // changed).
                self.spawn_command_catalog_refresh();
                // Tracked, so a back-to-back status rewrites it in place.
                self.note("Reloaded keybindings, skills, prompts, themes", view);
            }
            Err(error) => {
                self.error_row(&format!("Reload failed: {error}"), view);
            }
        }
        self.dirty = true;
    }
}
