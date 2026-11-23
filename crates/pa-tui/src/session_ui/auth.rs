//! The provider login/logout selectors and the inline auth panel, the
//! parked model sign-in, and the `/mcp` auth flow.
use super::{
    key_event_to_id, picker_viewport_rows, AgentView, AuthSelectorAction, AuthSelectorKind,
    DaemonCommand, Duration, KeyEvent, Map, ModelSelectionApplied, Result, SessionUi,
    UI_REQUEST_TIMEOUT_MS,
};

/// The outcome of one daemon `set_model` attempt: the switch landed, the provider is not signed in
/// (the sign-in flow owns the retry), or the switch failed (error row already rendered).
#[derive(Debug)]
pub(super) enum SetModelOutcome {
    Switched,
    NeedsSignIn,
    Failed,
}

/// A model selection parked on the provider's sign-in: a successful login retries the switch —
/// including the user-edited effort, exactly like a direct selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PendingModelSignIn {
    /// The provider the sign-in serves; the login outcome must match it.
    provider: String,
    model_id: String,
    /// The picked model's user-edited effort, applied after the retry.
    effort: Option<String>,
}

impl SessionUi {
    // Provider auth (/login, /logout)

    /// Fetch the hook's rows and mount the selector; an empty logout store
    /// answers the TS status directly.
    pub(crate) async fn open_provider_auth(
        &mut self,
        kind: AuthSelectorKind,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(auth) = self.provider_auth.clone() else {
            let command = if kind == AuthSelectorKind::Login {
                "/login"
            } else {
                "/logout"
            };
            self.note(
                &format!("{command} is not available in this client yet"),
                view,
            );
            return Ok(());
        };
        let rows = match kind {
            AuthSelectorKind::Login => auth.0.login_options().await,
            AuthSelectorKind::Logout => auth.0.logout_options().await,
        };
        if kind == AuthSelectorKind::Logout && rows.is_empty() {
            self.note(
                "No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
                view,
            );
            return Ok(());
        }
        view.editor.set_text("");
        view.provider_auth = Some(crate::provider_auth::ProviderAuthSelector::new(kind, rows));
        self.dirty = true;
        Ok(())
    }

    /// One key press while the provider selector owns the frame: Enter runs the row's flow; the
    /// panel-driven flows mount the inline auth panel and spawn.
    pub(crate) async fn handle_provider_auth_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        let action = {
            let Some(selector) = view.provider_auth.as_mut() else {
                return Ok(());
            };
            let kb = view.editor.keybindings();
            selector.handle_key(&id, kb)
        };
        match action {
            AuthSelectorAction::None => {}
            AuthSelectorAction::Cancel => {
                view.provider_auth = None;

                self.pending_model_sign_in = None;
            }
            AuthSelectorAction::LoginError { message } => {
                view.provider_auth = None;

                self.pending_model_sign_in = None;
                self.error_row(&message, view);
            }
            AuthSelectorAction::Login { provider, api_key } => {
                view.provider_auth = None;
                // The panel-prompted key: store it directly, no panel needed.
                if let Some(api_key) = api_key {
                    let auth = self.provider_auth.clone().expect("the selector was open");
                    let outcome = auth.0.login(&provider, Some(&api_key)).await;
                    self.apply_auth_outcome(outcome, &provider.id, view).await;
                    // Re-check the Anthropic subscription warning after credentials change —
                    // the credential's shape decides (a plain API key never warns).
                    self.maybe_warn_anthropic_subscription_auth_if_subscribed(
                        Some(provider.id.as_str()),
                        view,
                    )
                    .await;
                } else {
                    let auth = self.provider_auth.clone().expect("the selector was open");
                    if provider.id.starts_with("mcp:")
                        || provider.id == crate::provider_auth::PRIME_INFERENCE_PROVIDER_ID
                        || crate::provider_auth::SUBSCRIPTION_PROVIDER_IDS
                            .contains(&provider.id.as_str())
                    {
                        self.start_provider_panel_login(&provider, auth, view);
                    } else {
                        // A row reaching here answers the silent cancel — no after-selection
                        // error wall.
                        let outcome = auth.0.login(&provider, None).await;
                        self.apply_auth_outcome(outcome, &provider.id, view).await;
                    }
                }
            }
            AuthSelectorAction::Logout { provider } => {
                view.provider_auth = None;
                // The settled outcome drops any parked model sign-in, so a logout never
                // leaves a model waiting on the credential it removed.
                let auth = self.provider_auth.clone().expect("the selector was open");
                let outcome = auth.0.logout(&provider).await;
                self.apply_auth_outcome(outcome, &provider.id, view).await;
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// The auth panel's request channel: the onboarding phase drives its flows
    /// against the same channel the run loop services after the pane ends.
    pub(crate) fn auth_panel_handle(&self) -> crate::auth_panel::AuthPanelHandle {
        crate::auth_panel::AuthPanelHandle::new(self.auth_panel_notes.clone())
    }

    /// Enter on a panel-driven login row (the MCP OAuth, Prime Inference, and Codex Subscription
    /// logins): mount the inline auth panel and spawn the flow against it. Flows that check the
    /// cooperative cancel arm its shared flag so Esc/ctrl+c ends the flow without writing
    /// credentials.
    fn start_provider_panel_login(
        &mut self,
        provider: &crate::provider_auth::ProviderRow,
        auth: crate::provider_auth::ProviderAuthCommandsHandle,
        view: &mut AgentView,
    ) {
        let panel = crate::auth_panel::AuthPanelHandle::new(self.auth_panel_notes.clone());
        let mut session_dialog =
            crate::auth_panel::AuthPanel::new(format!("Login to {}", provider.name));
        session_dialog.set_cancel_signal(panel.cancel_signal());
        view.auth_panel = Some(session_dialog);
        // A still-running previous flow ends before its replacement arms: its
        // late settle is skipped below so it can never close the newer panel.
        if let Some(previous) = self.auth_panel_cancel.take() {
            previous.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        self.auth_panel_cancel = crate::provider_auth::SUBSCRIPTION_PROVIDER_IDS
            .contains(&provider.id.as_str())
            .then(|| panel.cancel_flag());
        let provider = provider.clone();
        tokio::spawn(async move {
            let outcome = auth.0.login_on_panel(&provider, panel.clone()).await;
            // The driving surface already exited (Esc, or a newer login re-armed): applying a stale
            // settle would close the NEWER flow's panel — so it never lands.
            if !panel.cancelled() {
                panel.send(crate::auth_panel::AuthPanelRequest::ProviderSettled {
                    provider: provider.id.clone(),
                    outcome,
                });
            }
        });
    }

    /// One key press while the inline auth panel owns the frame.
    pub(crate) fn handle_auth_panel_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The panel consumes Ctrl+C (cancel the mounted input, not the app);
        // report it so the force-quit guard stays in sync.
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let kb = view.editor.keybindings();
        if let Some(panel) = view.auth_panel.as_mut() {
            panel.handle_key(&id, kb, &mut self.osc_sink);
        }
        // A cancel key ends the mounted panel and arms the blocking body's flag. Only the binding
        // match unmounts: a raw ctrl+c with the binding remapped away is an unhandled key, not a
        // cancel — unmounting without marking leaves a live flow that can persist credentials.
        let cancel_key = kb.matches(&id, "tui.select.cancel");
        let team_picker = view
            .auth_panel
            .as_ref()
            .is_some_and(crate::auth_panel::AuthPanel::team_picker_mounted);
        if cancel_key && !team_picker {
            if let Some(cancel) = self.auth_panel_cancel.take() {
                cancel.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            view.auth_panel = None;
        }
        self.dirty = true;
        Ok(())
    }

    /// One flow outcome. The parked model sign-in is consumed by the outcome: a successful login of
    /// its provider retries the switch; a failed or cancelled flow drops the park.
    pub(crate) async fn apply_auth_outcome(
        &mut self,
        outcome: crate::provider_auth::ProviderAuthOutcome,
        provider: &str,
        view: &mut AgentView,
    ) {
        let parked = self
            .pending_model_sign_in
            .take()
            .filter(|pending| pending.provider == provider);
        match outcome {
            crate::provider_auth::ProviderAuthOutcome::Status(message) => {
                self.note(&message, view);
                if let Some(pending) = parked {
                    self.finish_model_sign_in(pending, view).await;
                }
                // A landed login or logout may change the auth scope the daemon's catalog refreshes
                // under: re-fetch now so the next open serves the new account's view.
                self.spawn_model_catalog_refresh();
            }
            crate::provider_auth::ProviderAuthOutcome::Error(message) => {
                self.error_row(&message, view);
            }
            // A cancelled flow stays silent.
            crate::provider_auth::ProviderAuthOutcome::Cancelled => {}
        }
    }

    /// One paste payload while the inline auth panel owns the frame: it lands in the panel's
    /// mounted input — never the hidden editor, where a later Enter could submit the secret as a
    /// prompt.
    pub(crate) fn paste_to_auth_panel(&mut self, text: &str, view: &mut AgentView) {
        if let Some(panel) = view.auth_panel.as_mut() {
            panel.handle_paste(text);
        }
        self.dirty = true;
    }

    /// One request from a login flow driving the inline auth panel: a request with no mounted panel
    /// cancels its flow; the settled requests unmount the panel and apply the outcome (a flow that
    /// never needed input still settles).
    pub(crate) async fn apply_auth_panel_request(
        &mut self,
        request: crate::auth_panel::AuthPanelRequest,
        view: &mut AgentView,
    ) {
        use crate::auth_panel::AuthPanelRequest;
        match request {
            AuthPanelRequest::Progress { message, .. } => {
                if let Some(panel) = view.auth_panel.as_mut() {
                    panel.push_progress(&message);
                }
            }
            AuthPanelRequest::Waiting { message } => {
                if let Some(panel) = view.auth_panel.as_mut() {
                    panel.push_waiting(&message);
                }
            }
            AuthPanelRequest::AuthUrl { url, instructions } => {
                if let Some(panel) = view.auth_panel.as_mut() {
                    panel.show_auth_url(url, instructions);
                }
            }
            AuthPanelRequest::PastePrompt {
                prompt,
                tone,
                style,
                allow_empty,
                reply,
            } => {
                if let Some(panel) = view.auth_panel.as_mut() {
                    panel.mount_paste(&prompt, tone, style, allow_empty, reply);
                }
            }
            AuthPanelRequest::SelectTeam {
                teams,
                current,
                reply,
            } => {
                if let Some(panel) = view.auth_panel.as_mut() {
                    panel.mount_teams(teams, current, reply);
                }
            }
            AuthPanelRequest::ProviderSettled { provider, outcome } => {
                self.auth_panel_cancel = None;
                view.auth_panel = None;
                // The warning fires on a COMPLETED login only: a cancelled or errored flow
                // never consumes the once-per-session gate.
                let completed = matches!(
                    outcome,
                    crate::provider_auth::ProviderAuthOutcome::Status(_)
                );
                self.apply_auth_outcome(outcome, &provider, view).await;
                if completed {
                    self.maybe_warn_anthropic_subscription_auth(&provider, view);
                }
            }
            AuthPanelRequest::McpSettled { note } => {
                view.auth_panel = None;
                self.note(&note, view);
            }
            AuthPanelRequest::TracesSettled { outcome, gen } => {
                // A superseded run's late settle cannot clear a newer login: the generation guard.
                if gen == self.traces_login_gen {
                    view.auth_panel = None;
                    self.finish_traces_login(outcome, view).await;
                }
            }
        }
        self.dirty = true;
    }

    /// `/mcp`: the bare command opens the inline connections view.
    pub(crate) async fn handle_mcp_command(
        &mut self,
        resolved: &pa_types::slash_commands::ResolvedSlashCommand,
        view: &mut AgentView,
    ) -> Result<()> {
        // `/mcp` is menu-only: the TS `handleMcpCommand` typed subcommands
        // (login/logout/...) are deliberately removed — the connections
        // view resolves its own auth internally, and a submitted argument
        // is the usage error. A partial + Tab opens the view filtered.
        if !resolved.args.trim().is_empty() {
            view.editor
                .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
            self.error_row("Usage: /mcp (Tab filters the menu)", view);
            return Ok(());
        }
        self.open_mcp_view("/mcp", view, "").await?;
        self.track_menu_opened("mcp", "command");
        Ok(())
    }

    /// Run one internal MCP auth request: mount the inline auth panel and spawn the command against
    /// it; the settled line folds in through the panel channel.
    pub(crate) fn run_mcp_auth(&mut self, view: &mut AgentView) {
        let Some(intent) = self.pending_mcp_auth.take() else {
            return;
        };
        let Some(auth) = self.client_auth.clone() else {
            self.note("/mcp is not available in this client yet", view);
            return;
        };
        let panel = crate::auth_panel::AuthPanelHandle::new(self.auth_panel_notes.clone());
        let mut mcp_dialog = crate::auth_panel::AuthPanel::new(intent.title);
        mcp_dialog.set_cancel_signal(panel.cancel_signal());
        view.auth_panel = Some(mcp_dialog);
        let args = intent.args;
        tokio::spawn(async move {
            let note =
                crate::client_auth::run_mcp_auth_command(auth.0.as_ref(), &args, panel.clone())
                    .await;
            panel.send(crate::auth_panel::AuthPanelRequest::McpSettled { note });
        });
    }

    /// Open the inline `/mcp` connections view over the daemon's `get_mcp_connections` roster, its
    /// filter prefilled with `search` (the daemon answers from local state, so the open is
    /// instant). `command` names the entry the user ran, so a failed roster load reports the
    /// command.
    pub(crate) async fn open_mcp_view(
        &mut self,
        command: &str,
        view: &mut AgentView,
        search: &str,
    ) -> Result<()> {
        let data = match self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetMcpConnections {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await
        {
            Ok(data) => data,
            Err(error) => {
                self.note(&format!("{command} failed: {error:#}"), view);
                return Ok(());
            }
        };
        let mut mcp_view = crate::mcp_view::McpView::from_response(
            &data,
            picker_viewport_rows(view.terminal_rows()),
        );
        if !search.trim().is_empty() {
            mcp_view.set_search(search);
        }
        view.mcp_view = Some(mcp_view);
        self.dirty = true;
        Ok(())
    }

    /// One key press while the `/mcp` connections view is open: Enter (or the paste flow) parks
    /// `pending_mcp_auth`, which the input loop mounts the auth panel for once the key handler
    /// returns.
    pub(crate) fn handle_mcp_view_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The view consumes Ctrl+C (close, not exit); report it so the force-quit
        // guard can disarm.
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let action = view
            .mcp_view
            .as_mut()
            .map(|mcp_view| mcp_view.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(crate::mcp_view::McpViewAction::None) | None => {}
            Some(crate::mcp_view::McpViewAction::Cancel) => {
                view.mcp_view = None;
                self.picker_restored_draft = false;
                self.dirty = true;
            }
            Some(crate::mcp_view::McpViewAction::Select { server, label }) => {
                view.mcp_view = None;
                self.dirty = true;
                // The Tab path's typed partial is fulfilled by the resolution; the
                // browse-restore path holds the user's draft instead.
                if self.picker_restored_draft {
                    self.picker_restored_draft = false;
                } else {
                    view.editor.set_text("");
                }
                // Enter runs the connection's login flow through the internal auth seam
                // (no submitted `/mcp login <name>` string).
                self.pending_mcp_auth = Some(McpAuthIntent {
                    args: format!("login {server}"),
                    title: format!("Login to {label}"),
                });
            }
            Some(crate::mcp_view::McpViewAction::Paste { server, label }) => {
                view.mcp_view = None;
                self.dirty = true;
                if self.picker_restored_draft {
                    self.picker_restored_draft = false;
                } else {
                    view.editor.set_text("");
                }
                // The inline paste panel's client surface: prompt for the
                // token, store it bound to the service endpoint, verify.
                self.pending_mcp_auth = Some(McpAuthIntent {
                    args: format!("paste {server}"),
                    title: format!("Connect {label}"),
                });
            }
            Some(crate::mcp_view::McpViewAction::Key { id, label }) => {
                view.mcp_view = None;
                self.dirty = true;
                if self.picker_restored_draft {
                    self.picker_restored_draft = false;
                } else {
                    view.editor.set_text("");
                }
                // The api-key credential's client surface: prompt for the
                // key (masked), store it in the credential's auth slot —
                // the exact contract the runtime reads.
                self.pending_mcp_auth = Some(McpAuthIntent {
                    args: format!("key {id}"),
                    title: format!("Connect {label}"),
                });
            }
        }
        Ok(())
    }

    /// Route a picked model whose provider is not signed in to the sign-in flow: park the
    /// selection, then mount the `/login` menu preselected on the provider's row.
    pub(crate) async fn begin_model_sign_in(
        &mut self,
        applied: &ModelSelectionApplied,
        view: &mut AgentView,
    ) {
        let provider = &applied.provider;
        let model_id = &applied.model_id;
        let Some(auth) = self.provider_auth.clone() else {
            self.error_row(
                &format!("Authentication for {provider} must be configured externally."),
                view,
            );
            return;
        };
        let rows = auth.0.login_options().await;
        if !rows.iter().any(|row| row.id == applied.provider) {
            self.error_row(
                &format!("Authentication for {provider} must be configured externally."),
                view,
            );
            return;
        }
        self.pending_model_sign_in = Some(PendingModelSignIn {
            provider: provider.clone(),
            model_id: model_id.clone(),
            effort: applied.effort.clone(),
        });
        self.note(
            &format!("Sign in to {provider} to use {provider}/{model_id}"),
            view,
        );
        // The picker's Apply arm already settled the editor (the command partial
        // cleared, a restored draft kept) — the sign-in route never rewrites it.
        let mut selector =
            crate::provider_auth::ProviderAuthSelector::new(AuthSelectorKind::Login, rows);
        selector.preselect_provider(provider);
        view.provider_auth = Some(selector);
        self.dirty = true;
    }

    /// The parked sign-in's retry: refresh the catalog, retry the switch
    /// exactly once, and apply the parked effort only after the switch lands.
    async fn finish_model_sign_in(&mut self, pending: PendingModelSignIn, view: &mut AgentView) {
        let PendingModelSignIn {
            provider,
            model_id,
            effort,
        } = pending;
        self.spawn_model_catalog_refresh();
        match self.try_set_model(&provider, &model_id, view).await {
            SetModelOutcome::Switched => {
                if let Some(level) = &effort {
                    self.apply_thinking_level(level, view).await;
                }
            }
            // The provider still refuses the switch after login: the post-login
            // re-check message, never a second sign-in route.
            SetModelOutcome::NeedsSignIn => {
                self.error_row(
                    &format!("Authentication completed, but {provider} is still unavailable."),
                    view,
                );
            }
            SetModelOutcome::Failed => {}
        }
    }
}

/// The `/mcp` view's parked auth request: the auth-args form (e.g. `login
/// <server>`) and the title the inline auth panel mounts.
pub(crate) struct McpAuthIntent {
    pub(crate) args: String,
    pub(crate) title: String,
}
