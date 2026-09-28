//! The sessions concern: the `/tree` and `/fork` selectors and the tree
//! navigation, `/clone`, and the session resume/list/switch surfaces.
use super::*;

impl SessionUi {
    // ------------------------------------------------------------------
    // Session-tree navigation (/tree, /fork, /clone)
    // ------------------------------------------------------------------

    /// Open the `/tree` selector over the session tree (TS
    /// `showTreeSelector`); `initial_selected` re-opens with the previous
    /// selection after a cancelled branch summary.
    pub(super) async fn open_tree_selector(
        &mut self,
        view: &mut AgentView,
        initial_selected: Option<&str>,
    ) -> Result<()> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetSessionTree {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await?;
        if data
            .get("flatNodes")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            self.note("No entries in session", view);
            return Ok(());
        }
        match TreeSelector::new(
            &data,
            view.terminal_rows(),
            self.branch_summary_skip_prompt,
            self.tree_filter_mode,
        ) {
            Some(mut selector) => {
                selector.set_initial_selection(initial_selected);
                view.tree_selector = Some(selector);
            }
            None => self.note("No entries in session", view),
        }
        self.dirty = true;
        Ok(())
    }

    /// One key press while the tree selector is open.
    pub(super) async fn handle_tree_selector_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        let action = {
            let Some(selector) = view.tree_selector.as_mut() else {
                return Ok(());
            };
            let kb = view.editor.keybindings();
            selector.handle_key(kb, &id)
        };
        match action {
            TreeSelectorAction::None => {}
            TreeSelectorAction::Cancel => {
                view.tree_selector = None;
            }
            TreeSelectorAction::LabelChange { entry_id, label } => {
                let request = DaemonCommand::SetSessionEntryLabel {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    entry_id: entry_id.clone(),
                    label: label.clone(),
                    rest: Map::default(),
                };
                match self
                    .bounded_request(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), request)
                    .await
                {
                    Ok(_) => {
                        if let Some(selector) = view.tree_selector.as_mut() {
                            selector.update_label(&entry_id, label.as_deref());
                        }
                    }
                    Err(error) => self.note(&format!("{error:#}"), view),
                }
            }
            TreeSelectorAction::Navigate {
                target_id,
                summarize,
                custom_instructions,
            } => {
                // Selecting the current leaf is a no-op (TS).
                let leaf = view
                    .tree_selector
                    .as_ref()
                    .and_then(|selector| selector.current_leaf_id().map(str::to_string));
                view.tree_selector = None;
                if leaf.as_deref() == Some(target_id.as_str()) {
                    self.note("Already at this point", view);
                    self.dirty = true;
                    return Ok(());
                }
                self.navigate_tree(&target_id, summarize, custom_instructions, view)
                    .await?;
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// The `navigate_tree` request and its rendering (TS
    /// `_navigateTreeUnderPause` + `renderTreeNavigation`).
    async fn navigate_tree(
        &mut self,
        target_id: &str,
        summarize: bool,
        custom_instructions: Option<String>,
        view: &mut AgentView,
    ) -> Result<()> {
        let result = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS * 3),
                DaemonCommand::NavigateTree {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    target_id: target_id.to_string(),
                    summarize: Some(summarize),
                    custom_instructions,
                    replace_instructions: None,
                    label: None,
                    rest: Map::default(),
                },
            )
            .await;
        let data = match result {
            Ok(data) => data,
            Err(error) => {
                self.note(&format!("{error:#}"), view);
                return Ok(());
            }
        };
        if data.get("aborted").and_then(Value::as_bool) == Some(true) {
            // The branch summary was cancelled: re-open the tree selector
            // with the same selection (TS).
            self.note("Branch summarization cancelled", view);
            return self.open_tree_selector(view, Some(target_id)).await;
        }
        if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
            self.note("Navigation cancelled", view);
            return Ok(());
        }
        self.rebuild_transcript(view).await;
        // A user-message target re-enters its text in the editor when it is
        // empty (TS `renderTreeNavigation`).
        if let Some(editor_text) = data.get("editorText").and_then(Value::as_str) {
            if view.editor.get_text().trim().is_empty() {
                view.editor.set_text(editor_text);
            }
        }
        self.note("Navigated to selected point", view);
        self.dirty = true;
        Ok(())
    }

    /// Open the `/fork` selector over the session's user messages (TS
    /// `showUserMessageSelector`).
    pub(super) async fn open_fork_selector(&mut self, view: &mut AgentView) -> Result<()> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetUserMessagesForForking {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await?;
        let messages: Vec<crate::user_message_selector::UserMessageItem> = data
            .get("messages")
            .and_then(Value::as_array)
            .map(|messages| {
                messages
                    .iter()
                    .filter_map(|message| {
                        Some(crate::user_message_selector::UserMessageItem {
                            id: message.get("entryId")?.as_str()?.to_string(),
                            text: message.get("text")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if messages.is_empty() {
            self.note("No messages to fork from", view);
            return Ok(());
        }
        view.fork_selector = Some(UserMessageSelector::new(messages));
        self.dirty = true;
        Ok(())
    }

    /// One key press while the fork selector is open.
    pub(super) async fn handle_fork_selector_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        let action = {
            let Some(selector) = view.fork_selector.as_mut() else {
                return Ok(());
            };
            let kb = view.editor.keybindings();
            selector.handle_key(kb, &id)
        };
        match action {
            UserMessageSelectorAction::Select(entry_id) => {
                view.fork_selector = None;
                self.fork(&entry_id, None, view).await?;
            }
            UserMessageSelectorAction::Cancel => {
                view.fork_selector = None;
            }
            UserMessageSelectorAction::None => {}
        }
        self.dirty = true;
        Ok(())
    }

    /// The `fork` request (TS `AgentSessionRuntime.fork`): the worker
    /// copies the path into a new session and switches to it.
    async fn fork(
        &mut self,
        entry_id: &str,
        position: Option<pa_types::daemon::ForkPosition>,
        view: &mut AgentView,
    ) -> Result<()> {
        let data = match self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS * 3),
                DaemonCommand::Fork {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    entry_id: entry_id.to_string(),
                    position,
                    rest: Map::default(),
                },
            )
            .await
        {
            Ok(data) => data,
            Err(error) => {
                self.note(&format!("fork failed: {error:#}"), view);
                return Ok(());
            }
        };
        if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
            return Ok(());
        }
        self.rebuild_transcript(view).await;
        let selected_text = data.get("selectedText").and_then(Value::as_str);
        match selected_text {
            Some(text) => view.editor.set_text(text),
            None => view.editor.set_text(""),
        }
        self.note("Forked to new session", view);
        self.dirty = true;
        Ok(())
    }

    /// `/clone` (TS `handleCloneCommand`): fork at the current leaf.
    pub(super) async fn handle_clone_command(&mut self, view: &mut AgentView) -> Result<()> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetSessionTree {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await?;
        let Some(leaf_id) = data.get("leafId").and_then(Value::as_str) else {
            self.note("Nothing to clone yet", view);
            return Ok(());
        };
        if leaf_id.is_empty() {
            self.note("Nothing to clone yet", view);
            return Ok(());
        }
        self.fork(leaf_id, Some(pa_types::daemon::ForkPosition::At), view)
            .await?;
        self.note("Cloned to new session", view);
        self.dirty = true;
        Ok(())
    }

    /// `/resume <selector>`: a session file path, an `<id>.jsonl` under the
    /// sessions dir, or a live daemon session id (attach). Mirrors the CLI
    /// selector resolution in `interactive_mode.rs`.
    pub(super) fn resolve_resume_selector(&self, selector: &str) -> Option<SessionSelection> {
        let selector = selector.trim();
        if selector.is_empty() {
            return None;
        }
        let path = std::path::Path::new(selector);
        if path.is_file() {
            return Some(SessionSelection::Resume(path.to_path_buf()));
        }
        if let Some(dir) = &self.session_dir {
            let candidate = dir.join(format!("{selector}.jsonl"));
            if candidate.is_file() {
                return Some(SessionSelection::Resume(candidate));
            }
        }
        Some(SessionSelection::Attach(selector.to_string()))
    }

    /// Options for `/new`: same socket, cwd, persistence, and script seam as
    /// the original run.
    pub(super) fn create_options(&self) -> InteractiveOptions {
        InteractiveOptions {
            socket_path: self.client.socket_path().to_path_buf(),
            cwd: self.cwd.clone(),
            session_dir: self.session_dir.clone(),
            script_path: self.script_path.clone(),
            model_selection: self.model_selection.clone(),
            model_catalog: self.model_catalog.clone(),
            model_configured_providers: self.model_configured_providers.clone(),
            model_recent_models: self.model_recent_models.clone(),
            default_thinking_level: self.default_thinking_level.clone(),
            no_session: false,
            session: SessionSelection::New,
            initial_message: None,
            telemetry_disabled: self.telemetry_disabled,
            theme: String::new(),
            code_block_indent: self.code_block_indent.clone(),
            show_images: self.show_images,
            fullscreen_mouse: self.fullscreen_mouse,
            tree_filter_mode: self.tree_filter_mode.wire_name().to_string(),
            branch_summary_skip_prompt: self.branch_summary_skip_prompt,
            version: String::new(),
            onboarding: None,
            client_auth: self.client_auth.clone(),
            traces: self.traces.clone(),
            provider_auth: self.provider_auth.clone(),
            update_commands: self.update_commands.clone(),
            telemetry: self.telemetry.clone(),
            keybindings: self.keybindings.clone(),
            // The `/new` run keeps this process's stash store: a draft
            // stashed for the fresh session survives into the next chat
            // view that binds it.
            prompt_stash: self.prompt_stash.clone(),
            // `/new` starts a fresh root session: no depth label.
            session_rlm_depth: None,
            session_has_children: false,
            restore_dock_focus: false,
            client_settings: self.client_settings.clone(),
        }
    }

    pub(super) async fn refresh_list(&mut self, view: &mut AgentView) -> Result<()> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::List {
                    id: None,
                    all: None,
                    cwd: None,
                    session_dir: None,
                    include_client_owned: None,
                    rest: Map::default(),
                },
            )
            .await?;
        let sessions = data
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.list_rows = sorted_session_rows(sessions);
        let sessions = &self.list_rows;
        // The listing renders in the read-only info panel (the
        // operator's 2026-09-26 directive): it no longer lands in the
        // transcript as a multi-line status row. The row content is
        // unchanged — `/switch <n|id>` still resolves against the same
        // cached rows.
        let raw = |text: String| vec![info_commands::ClientSpan { text, color: None }];
        let mut rows = vec![raw("live sessions:".to_string())];
        if sessions.is_empty() {
            rows.push(raw("  (none)".to_string()));
        }
        for (index, row) in sessions.iter().enumerate() {
            let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
            let current = if id == self.active_session_id {
                "*"
            } else {
                " "
            };
            let name = row
                .get("sessionName")
                .and_then(Value::as_str)
                .or_else(|| row.get("sessionId").and_then(Value::as_str))
                .unwrap_or_default();
            let activity = row
                .get("activity")
                .and_then(Value::as_str)
                .unwrap_or("idle");
            let cwd = row.get("cwd").and_then(Value::as_str).unwrap_or_default();
            rows.push(raw(format!(
                "{current} {}. {name} ({id}) {activity} {cwd}",
                index + 1
            )));
        }
        rows.push(raw("switch with /switch <n|id>".to_string()));
        self.open_info_panel(view, Some("Sessions".to_string()), InfoContent::Rows(rows));
        self.track_menu_opened("list", "command");
        Ok(())
    }

    /// `/switch`: resolve the argument against the cached `/list` rows (1-based
    /// index or session id), then reattach.
    pub(super) async fn switch_to(&mut self, target: &str, view: &mut AgentView) -> Result<()> {
        let id = match target.parse::<usize>() {
            Ok(index) => self
                .list_rows
                .get(index.wrapping_sub(1))
                .and_then(|row| row.get("id").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| target.to_string()),
            Err(_) => target.to_string(),
        };
        if id == self.active_session_id {
            self.note("already attached to that session", view);
            return Ok(());
        }
        // The draft in the editor belongs to the session being left: stash
        // it as that session's restore-on-reopen head and clear the editor,
        // so the switch lands on an empty prompt (the draft returns on a
        // switch back).
        self.stash_draft_for_switch(view);
        match self.attach_session(&id, DockFold::FirstFrame).await {
            Ok(()) => {
                // Session-scoped stats again: the rebuilt title must show
                // the switched-to session's pair, not the one being left.
                self.refresh_stats().await;
                self.rebuild_view(view, RebuildKind::Rebind);
                self.note(&format!("switched to session {id}"), view);
                // The switched-to session's own restore head (if one was
                // stashed earlier) lands after the switch note, so the
                // restore status is the row the back-to-back rewrite keeps
                // (TS `showStatus` last-wins).
                self.restore_prompt_stash_if_editor_empty(view);
            }
            Err(error) => {
                self.note(&format!("switch to {id} failed: {error:#}"), view);
            }
        }
        Ok(())
    }
}

/// Deterministic list order: most recently active first (missing activity
/// timestamps last), so `/switch <n>` targets are stable between `/list`
/// renders.
/// The terminal's current column count (TS `this.ui.terminal.columns` for
/// the goal status detail suffix); 80 when the size is unavailable.
pub(super) fn terminal_columns() -> usize {
    crossterm::terminal::size().map_or(80, |(columns, _)| columns as usize)
}

fn sorted_session_rows(mut sessions: Vec<Value>) -> Vec<Value> {
    let activity_of = |row: &Value| -> String {
        row.get("lastActivityAt")
            .or_else(|| row.get("modified"))
            .or_else(|| row.get("created"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    sessions.sort_by(|left, right| {
        let (left, right) = (activity_of(left), activity_of(right));
        if left.is_empty() && right.is_empty() {
            return std::cmp::Ordering::Equal;
        }
        if left.is_empty() {
            return std::cmp::Ordering::Greater;
        }
        if right.is_empty() {
            return std::cmp::Ordering::Less;
        }
        right.cmp(&left)
    });
    sessions
}

/// Send a `create` command and return the new session's active id. A
/// non-empty selection picks the reopen form: `continueRecent` or an
/// explicit saved-session path.
pub(super) async fn create_session(
    client: &DaemonClient,
    options: &InteractiveOptions,
    selection: Option<&SessionSelection>,
) -> Result<String> {
    let session_path = match selection {
        Some(SessionSelection::Resume(path)) => Some(path.to_string_lossy().to_string()),
        _ => None,
    };
    // The create consumes the path; a refusal needs it again for the
    // descriptive error.
    let refused_path = session_path.clone();
    let data = match client
        .request_ok(DaemonCommand::Create {
            id: None,
            session_path,
            // A create names its session (`sessionPath`) or opens one
            // through the agents view; `continueRecent` stays absent
            // (TS wire shape — the supervisor refuses it).
            continue_recent: None,
            no_session: options.no_session.then_some(true),
            name: None,
            config: Some(options.create_config()),
            telemetry_disabled: options.telemetry_disabled.filter(|disabled| *disabled),
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: Map::default(),
        })
        .await
    {
        Ok(data) => data,
        Err(error) => {
            return Err(describe_session_open_failure(client, error, refused_path).await);
        }
    };
    data.get("activeSessionId")
        .or_else(|| data.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("the daemon did not report a session id for the new session"))
}

/// A create refusal for a session file another holder already owns
/// names the holder and the next steps (the operator-directed
/// descriptive session-open error) instead of stopping at the bare
/// lease id. Any other failure propagates unchanged.
async fn describe_session_open_failure(
    client: &DaemonClient,
    error: anyhow::Error,
    session_path: Option<String>,
) -> anyhow::Error {
    // Only a typed daemon rejection decorates (transport failures pass
    // through unchanged), and the RAW rejection message is what gets
    // decorated — the typed wrapper's own display adds the framing
    // prefix exactly once.
    let Some((rejected, error_info)) = error
        .downcast_ref::<crate::daemon_client::RequestRejected>()
        .map(|rejected| (rejected.message.clone(), rejected.error_info.clone()))
    else {
        return error;
    };
    let Some(owner) = crate::session_open_error::owner_from_refusal(&rejected) else {
        return error;
    };
    let Some(path) = session_path.map(std::path::PathBuf::from) else {
        return error;
    };
    // The live-roster probe is best-effort and BOUNDED: a stalled `list`
    // must not hold the refusal for the daemon's full request timeout —
    // the startup hands off to the agents view promptly either way.
    let rows: Vec<Value> = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        client.request_ok(DaemonCommand::List {
            id: None,
            all: None,
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: Map::default(),
        }),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .map(|data| crate::session_open_error::roster_rows(&data).to_vec())
    .unwrap_or_default();
    // The path-keyed lookup first; the refusal's own holder id is the
    // fallback (a relative resume path can miss the canonical row).
    let holder = crate::session_open_error::holder_from_roster(&rows, &path)
        .or_else(|| crate::session_open_error::holder_by_id(&rows, &owner));
    // The daemon's ORIGINAL refusal line stays verbatim (never
    // reconstructed from a possibly-relative caller path) and the holder
    // guidance rides the same line — the agents-view handoff renders the
    // notice on a single status line, so a multiline decoration would
    // hide the holder and the next steps.
    let message =
        crate::session_open_error::decorate_interactive_refusal(&rejected, holder, &owner);
    // The refusal stays a typed `RequestRejected`: `is_daemon_rejection`
    // keeps classifying it (the interactive open hands off to the agents
    // view with the notice instead of exiting the client).
    anyhow::Error::new(crate::daemon_client::RequestRejected {
        command: "create".to_string(),
        message,
        // The typed refusal info rides the decorated refusal unchanged
        // (an `update_restarting` create refusal never reaches this
        // decorator: `owner_from_refusal` passes it through untouched).
        error_info,
    })
}
