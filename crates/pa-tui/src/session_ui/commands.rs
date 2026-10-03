//! The client-command dispatch concern: the slash-command ladder
//! (`handle_slash`), the builtin client-command dispatch tail, the
//! command-catalog refresh/fold, and the connection-state read the
//! commands share.
use super::{
    create_session, effort_picker, info_commands, terminal_columns, AgentView, AuthSelectorKind,
    ChatEntry, CommandCatalogUpdate, DaemonCommand, DockFold, Duration, InfoContent, Map,
    PendingConfirm, RebuildKind, Result, SessionUi, SlashCommandExecution, SlashCommandRegistry,
    StatusKind, SubmitBehavior, Value, UI_REQUEST_TIMEOUT_MS,
};

impl SessionUi {
    /// Slash-command dispatch (the TS interactive submission ladder reduced
    /// to this client's surface): local client commands run here, builtin
    /// client commands without a UI yet report unavailability, session
    /// commands (`compact`/`refine`/`goal`/`autonomous`) forward to the
    /// session, and unknown commands get the TS suggestion error — anything
    /// without a suggestion passes through as a prompt.
    ///
    /// `behavior` is TS `onSubmit`'s captured `streamingBehavior`: the
    /// submit lane that carried the text (alt+enter = followUp), passed
    /// through to every fallthrough prompt — TS sends the fallthrough with
    /// the submit's own lane, so a slash-prefixed follow-up keeps parking
    /// on the follow-up lane (Bugbot's lost-lane finding).
    pub(super) async fn handle_slash(
        &mut self,
        text: &str,
        behavior: SubmitBehavior,
        view: &mut AgentView,
    ) -> Result<()> {
        let registry = SlashCommandRegistry::builtin();
        let (name, args) = pa_types::slash_commands::parse_slash_command(text)
            .unwrap_or_else(|| (String::new(), String::new()));

        // A bare `/skill:<name>` submit never sends. The daemon's
        // admission seam replaces a sent skill command with its expanded
        // protocol block, so a bare invocation would hand the model the
        // protocol as its only user message with no task attached (the
        // engine floor appends a harness-owned instruction at the far
        // end; this guard keeps the taskless submission from ever
        // starting). The draft restores into the editor, the notice
        // names the fix, and the user stays put to type the request.
        if name.starts_with("skill:") && args.trim().is_empty() {
            // The draft restores INTO THE ARGUMENT POSITION (the trailing
            // space the completion added survives the round trip): the
            // next keystrokes become the request instead of gluing onto
            // the command name, so the recovery flow is one step.
            view.editor.set_text(&format!("{text} "));
            self.note(
                "add your request after the skill, e.g. /skill:prime-agent-release make a release of PR #2731",
                view,
            );
            return Ok(());
        }

        // Client-local commands this build implements (not TS builtins).
        match name.as_str() {
            "help" => {
                self.note(
                    "/help           this list\n/list           live sessions\n/switch <n|id>  switch to a session from /list\n/new            start a new session\n/exit           detach and exit",
                    view,
                );
                return Ok(());
            }
            "list" => {
                self.refresh_list(view).await?;
                return Ok(());
            }
            "switch" => {
                if args.is_empty() {
                    self.note("usage: /switch <n|id> (run /list first)", view);
                } else {
                    self.switch_to(&args, view).await?;
                }
                return Ok(());
            }
            "exit" => {
                self.exit_requested = true;
                return Ok(());
            }
            _ => {}
        }

        let Some(resolved) = registry.parse(text) else {
            // Oversized names are prompts (TS `_throwIfUnknownSlashCommand`
            // bails out before fuzzy matching). Close typos get the exact TS
            // error; everything else passes through to the model.
            if name.chars().count() > 64 {
                return self.send_prompt(text, behavior, view);
            }
            let candidates = registry.suggestion_candidates();
            return match pa_types::slash_commands::find_slash_command_suggestion(&name, &candidates)
            {
                Some(suggestion) => {
                    self.note(
                        &format!("Unknown command: /{name}. Did you mean /{suggestion}?"),
                        view,
                    );
                    Ok(())
                }
                None => self.send_prompt(text, behavior, view),
            };
        };

        let command = registry
            .get(resolved.name)
            .expect("resolved name is builtin");
        // `agent command used` (TS `captureAgentCommandUsed`): one report
        // per submitted builtin, client and session commands alike, by its
        // canonical name, before the command runs.
        self.track_command_used(resolved.name);
        match command.execution {
            SlashCommandExecution::Session => self.send_prompt(text, behavior, view),
            SlashCommandExecution::Client => {
                self.dispatch_client_command(&resolved, text, view).await
            }
        }
    }

    /// TS `handleClearCommand` (the `/new` flow, interactive-mode.ts:4703,
    /// :12486): create a fresh session and rebind the view to it. The
    /// `/new` command and the `app.session.new` action share it.
    pub(super) async fn start_new_session(&mut self, view: &mut AgentView) -> Result<()> {
        let id = create_session(&self.client, &self.create_options(), None).await?;
        self.attach_session(&id, DockFold::Fresh).await?;
        // The title's pair is session-scoped: fetch the new session's
        // stats before the rebuild copies them into the chrome, or the
        // rebind would ride the session being left's own cost and
        // subagent aggregate.
        self.refresh_stats().await;
        self.rebuild_view(view, &RebuildKind::Rebind);
        // TS `resetCurrentSessionRenderState`: a new session starts with
        // no draft and no prompt history (the submitted `/new` drains the
        // draft already, so only the history clear changes there).
        view.editor.clear_history();
        view.editor.set_text("");
        self.note(&format!("started session {id}"), view);
        self.track_feature_outcome("new", "completed", None);
        Ok(())
    }

    /// A builtin client command. Only the implemented subset runs locally;
    /// commands whose UI does not exist yet report unavailability. `text` is
    /// the typed submission (the client echo rows render it verbatim).
    async fn dispatch_client_command(
        &mut self,
        resolved: &pa_types::slash_commands::ResolvedSlashCommand,
        text: &str,
        view: &mut AgentView,
    ) -> Result<()> {
        match resolved.name {
            // `/clear` stays the no-argument compatibility alias of `/new`
            // (TS refuses arguments to it).
            "new" if resolved.original_name == "clear" && !resolved.args.is_empty() => {
                self.note("Usage: /clear", view);
            }
            "new" => {
                // The lane's app.session.new dispatch owns /new: the
                // startup-scope-aware session start (draft and prompt
                // history cleared, the status row, the feature outcome)
                // lives in one place, the same route the key takes.
                self.start_new_session(view).await?;
            }
            // TS `/quit` shuts the client down; this build's exit detaches
            // and exits (the session keeps running in the daemon).
            "quit" => {
                self.exit_requested = true;
            }
            // `/resume` (TS: open the agents view, or resume a session by
            // id or path). Both paths detach this session first; the CLI
            // loop then opens the agents view or the resolved selection.
            "resume" => {
                if resolved.args.is_empty() {
                    self.open_agents_view = true;
                    self.exit_requested = true;
                } else {
                    match self.resolve_resume_selector(&resolved.args) {
                        Some(selection) => {
                            self.pending_selection = Some(selection);
                            self.exit_requested = true;
                        }
                        None => {
                            self.note(
                                &format!("could not resolve session \"{}\"", resolved.args),
                                view,
                            );
                        }
                    }
                }
            }
            // `/model` opens the model picker (menu-only: the TS
            // `handleModelCommand` inline-arg form — an exact match applies
            // directly, anything else prefills the search — is deliberately
            // removed; a partial + Tab opens the picker filtered instead,
            // and a submitted argument is the usage error).
            "model" => {
                if !resolved.args.trim().is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /model (Tab filters the picker)", view);
                    return Ok(());
                }
                self.open_model_picker(view, "").await?;
                self.track_menu_opened("model", "command");
                self.track_feature_outcome("model", "initiated", None);
            }
            // `/effort [level]` (TS `handleEffortCommand`): the
            // session's thinking levels drive the outcome — a model
            // without reasoning reports the TS note, a missing argument
            // opens the picker, and a valid argument applies directly.
            "effort" => {
                let Some(state) = self.connection_state(view).await else {
                    return Ok(());
                };
                let levels: Vec<String> = state
                    .get("availableThinkingLevels")
                    .and_then(Value::as_array)
                    .map(|levels| {
                        levels
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                // TS `getAvailableThinkingLevels`: an "off"-only list is
                // no thinking surface.
                let levels: Vec<String> = if levels.len() == 1 && levels[0] == "off" {
                    Vec::new()
                } else {
                    levels
                };
                let current = state
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                match effort_picker::effort_command(&levels, current.as_deref(), &resolved.args) {
                    effort_picker::EffortCommandOutcome::Open(picker) => {
                        view.effort_picker = Some(picker);
                        self.track_feature_outcome("effort", "initiated", None);
                    }
                    effort_picker::EffortCommandOutcome::Unsupported => {
                        self.note("Current model does not support thinking", view);
                    }
                    effort_picker::EffortCommandOutcome::Unknown { requested, levels } => {
                        // TS `showError`: the ⚠ Error row, not the muted note.
                        view.push_entry(ChatEntry::Status {
                            text: format!(
                                "\u{26a0} Error: Unknown thinking level '{requested}'. Available: {}",
                                levels.join(", ")
                            ),
                            kind: StatusKind::Error,
                        });
                        self.dirty = true;
                    }
                    effort_picker::EffortCommandOutcome::Apply { level } => {
                        self.apply_thinking_level(&level, view).await;
                    }
                }
            }
            // `/tree` (TS `showTreeSelector`): the session-tree navigator.
            "tree" => {
                if resolved.args.is_empty() {
                    self.track_feature_outcome("tree", "initiated", None);
                    self.open_tree_selector(view, None).await?;
                } else {
                    self.note("Usage: /tree", view);
                }
            }
            // `/fork` (TS `showUserMessageSelector`): fork from a user
            // message into a new session.
            "fork" => {
                if resolved.args.is_empty() {
                    self.track_feature_outcome("fork", "initiated", None);
                    self.open_fork_selector(view).await?;
                } else {
                    self.note("Usage: /fork", view);
                }
            }
            // `/clone` (TS `handleCloneCommand`): duplicate the session at
            // the current position.
            "clone" => {
                if resolved.args.is_empty() {
                    self.track_feature_outcome("clone", "initiated", None);
                    self.handle_clone_command(view).await?;
                } else {
                    self.note("Usage: /clone", view);
                }
            }
            // TS `handleCopyCommand`: the last assistant text (the
            // daemon `get_last_assistant_text` lookup) copied to the
            // clipboard (platform tools, OSC 52 fallback). An argument is
            // the usage error with the text kept in the editor.
            "copy" => {
                if resolved.args.is_empty() {
                    self.handle_copy_command(view).await?;
                } else {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /copy", view);
                }
            }
            // `/login` (TS `showConfigurationMenu("providers")`): the
            // providers selector this build ports of that tab (the full
            // configuration menu stays unported; the panel is the same
            // TS `OAuthSelectorComponent` the tab mounts).
            "login" => {
                if resolved.args.is_empty() {
                    self.open_provider_auth(AuthSelectorKind::Login, view)
                        .await?;
                    self.track_feature_outcome("login", "initiated", None);
                } else {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /login", view);
                }
            }
            // `/logout` (TS `showLogoutSelector`): the stored-credential
            // selector; an empty store answers the TS status directly.
            "logout" => {
                if resolved.args.is_empty() {
                    self.open_provider_auth(AuthSelectorKind::Logout, view)
                        .await?;
                    self.track_feature_outcome("logout", "initiated", None);
                } else {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /logout", view);
                }
            }
            // `/import <path.jsonl>` (TS `handleImportCommand`): the
            // path parses like `/export`'s, then the confirm guards the
            // replacement.
            "import" => {
                let command_text = if resolved.args.is_empty() {
                    "/import".to_string()
                } else {
                    format!("/import {}", resolved.args)
                };
                self.open_import_confirm(&command_text, view);
            }
            // `/traces [status|on|off|preview|upload|upload-current|
            // upload-all|login]` (TS `handleTracesCommand`): the status
            // block, the settings writes, and the TS command shapes over
            // the upload subsystem this build has.
            "traces" => {
                self.handle_traces_command(resolved, view).await?;
            }
            // `/nightly [on|off|status]` (TS `interactive-mode.ts`
            // 5455-5484): status resolves the effective channel; on (or
            // bare) and off/stable save the `updateChannel` setting that
            // `/update` and `prime-agent update` follow.
            "nightly" => {
                let arg = resolved.args.trim().to_lowercase();
                if arg == "status" {
                    // The effective channel resolves through the
                    // client-settings seam (pa-tui cannot reach the
                    // update flow's resolver); a surface without the
                    // seam never claims a channel.
                    let Some(settings) = &self.client_settings else {
                        self.note("/nightly is not available in this client yet", view);
                        return Ok(());
                    };
                    let preferred = settings.update_channel();
                    let channel = settings.effective_update_channel(&view.chrome.version);
                    let source = if preferred.is_some() {
                        "set in settings"
                    } else {
                        "inferred from the running version"
                    };
                    self.note(
                        &format!(
                            "Updates follow the {channel} channel ({source}). v{} installed.",
                            view.chrome.version
                        ),
                        view,
                    );
                    return Ok(());
                }
                if arg == "off" || arg == "stable" {
                    // The pin persists through the client-settings seam; a
                    // surface without the seam never claims the pin (TS
                    // always has a settings manager, so the gate is this
                    // client's honesty guard).
                    let Some(settings) = &self.client_settings else {
                        self.note("/nightly is not available in this client yet", view);
                        return Ok(());
                    };
                    if let Err(error) = settings.set_update_channel("stable") {
                        self.error_row(&format!("{error:#}"), view);
                        return Ok(());
                    }
                    self.note(
                        "Updates now follow the stable channel. Run /update to install the latest build.",
                        view,
                    );
                    return Ok(());
                }
                if !arg.is_empty() && arg != "on" {
                    self.error_row("Usage: /nightly [on|off|status]", view);
                    return Ok(());
                }
                let Some(settings) = &self.client_settings else {
                    self.note("/nightly is not available in this client yet", view);
                    return Ok(());
                };
                if let Err(error) = settings.set_update_channel("nightly") {
                    self.error_row(&format!("{error:#}"), view);
                    return Ok(());
                }
                self.note(
                    "Updates now follow the nightly channel. Run /update to install the latest nightly build.",
                    view,
                );
            }
            // `/factory [on|off|status]`: the factory's opt-in gate (the
            // operator's directive: the factory is disabled until the
            // user turns it on). The toggle persists `factory.enabled` —
            // the shared settings key the daemon's `factory_activity`
            // advertisement and the kernel's factory gate read — so the
            // factory surfaces on the next client start (the running
            // connection keeps the advertisement its hello was built
            // with).
            "factory" => {
                let arg = resolved.args.trim().to_lowercase();
                match arg.as_str() {
                    "on" => {
                        let Some(settings) = &self.client_settings else {
                            self.note("/factory is not available in this client yet", view);
                            return Ok(());
                        };
                        if let Err(error) = settings.set_factory_enabled(true) {
                            self.error_row(&format!("{error:#}"), view);
                            return Ok(());
                        }
                        self.note(
                            "The factory is enabled. Restart the client to surface the factory group (the factory page and the agent-side factory API follow the same gate).",
                            view,
                        );
                    }
                    "off" => {
                        // The lifecycle guard (the review round's finding):
                        // the kernel's control loop is not gated by the
                        // setting, so `off` while runs are live would keep
                        // admitting and collecting children while every
                        // factory surface — the namespace, the activity
                        // lane, and the page after the next client start —
                        // refuses: a running factory loses its stop and
                        // visibility path until the gate is enabled again.
                        // The write refuses while the session's kernel
                        // reports live runs, naming the count the dock
                        // shows; the runs stop first (the page's stop
                        // action or `rlm.factory.stop`). An unreadable
                        // count fails closed on the lane-advertised client
                        // (the only state where the guard matters): the
                        // count's own failure classes — a timed-out or
                        // malformed lane reply — cannot prove zero live
                        // runs, and an unknown liveness must not open the
                        // gate; the client retries once the lane answers.
                        // The kernel-not-running refusal never reaches the
                        // unreadable arm: the lane never builds a kernel
                        // and the kernel owns its run registry in memory,
                        // so that class reads as a definitive zero
                        // (`live_factory_runs`), not an unknown liveness —
                        // the off proceeds for a session with no kernel.
                        // A client whose hello never advertised the lane
                        // keeps the fail-open read: an older daemon has no
                        // executor to protect, and a client started before
                        // `/factory on` already sees the frozen hello the
                        // settled surfaces rule describes.
                        let lane_advertised = self.factory_activity_supported();
                        match self.live_factory_runs().await {
                            Some(live) if live > 0 => {
                                let runs = if live == 1 { "run is" } else { "runs are" };
                                let them = if live == 1 { "it" } else { "them" };
                                self.error_row(
                                    &format!(
                                        "Cannot disable the factory while {live} {runs} still live — stop {them} first (the factory page's stop action or rlm.factory.stop), then /factory off."
                                    ),
                                    view,
                                );
                                return Ok(());
                            }
                            None if lane_advertised => {
                                self.error_row(
                                    "Cannot disable the factory: the live-run count could not be read from the factory lane — try /factory off again once it answers.",
                                    view,
                                );
                                return Ok(());
                            }
                            Some(_) | None => {}
                        }
                        let Some(settings) = &self.client_settings else {
                            self.note("/factory is not available in this client yet", view);
                            return Ok(());
                        };
                        if let Err(error) = settings.set_factory_enabled(false) {
                            self.error_row(&format!("{error:#}"), view);
                            return Ok(());
                        }
                        self.note(
                            "The factory is disabled. The factory group and page disappear on the next client start.",
                            view,
                        );
                    }
                    "" | "status" => {
                        let Some(settings) = &self.client_settings else {
                            self.note("/factory is not available in this client yet", view);
                            return Ok(());
                        };
                        if settings.factory_enabled() {
                            self.note(
                                "The factory is enabled. Run /factory off to disable it.",
                                view,
                            );
                        } else {
                            self.note(
                                "The factory is disabled (off by default). Run /factory on to enable it (takes effect on the next client start).",
                                view,
                            );
                        }
                    }
                    _ => self.error_row("Usage: /factory [on|off|status]", view),
                }
            }
            // `/telemetry [status|on|off]`: the report (on/off and why, the
            // endpoint, the installation id), or the persisted switch the
            // running telemetry clients re-read at their next send.
            "telemetry" => {
                let Some(settings) = &self.client_settings else {
                    self.note("/telemetry is not available in this client yet", view);
                    return Ok(());
                };
                let report = match resolved.args.trim().to_lowercase().as_str() {
                    "" | "status" => Ok(settings.telemetry_status()),
                    "on" => settings.set_telemetry_enabled(true),
                    "off" => settings.set_telemetry_enabled(false),
                    _ => {
                        self.error_row("Usage: /telemetry [status|on|off]", view);
                        return Ok(());
                    }
                };
                match report {
                    Ok(report) => self.note(&report, view),
                    Err(error) => self.error_row(&format!("{error:#}"), view),
                }
            }
            // `/update` (the TS->Rust migration path): the confirm, then
            // the download+install runs OUT-OF-BAND (a background task —
            // the TUI stays mounted, the daemon keeps running, and the
            // update replaces only the on-disk binary, so the new build
            // takes effect on restart and nothing here blocks or tears
            // down; there is no busy guard to keep). The confirm carries
            // the preserve invariant: the update uninstalls the
            // TypeScript version and installs the latest Rust build;
            // sessions and configuration (~/.prime/agent) are never
            // touched.
            "update" => {
                if !resolved.args.trim().is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /update", view);
                    return Ok(());
                }
                if self.update_in_flight {
                    self.note_as(
                        "An update is already running; its outcome lands here when it finishes.",
                        StatusKind::Warning,
                        view,
                    );
                    return Ok(());
                }
                view.editor.set_text("");
                // The message is hand-wrapped to fit the panel rows (the
                // confirm renders each line truncated, never wrapped).
                view.confirm = Some(crate::confirm::ConfirmPanel::yes_no(
                    "Update Prime Agent",
                    "Update uninstalls the TypeScript version and installs the latest Rust build;\nyour sessions and configuration (~/.prime/agent) are never touched.\n\nThe update runs in the background — restart prime-agent after it\nfinishes to run the new build.",
                ));
                self.pending_confirm = Some(PendingConfirm::Update);
                self.dirty = true;
            }
            // TS `handleMcpCommand`'s login/logout branches: the auth
            // flows run in the client process (the composition root's
            // hook); the other management subcommands surface through the
            // `mcp` CLI command instead of the TUI.
            "mcp" => self.handle_mcp_command(resolved, view).await?,
            // `/plugins [search]` (TS `handlePluginsCommand` ->
            // `showServiceCatalogPicker`): the external-services catalog
            // picker. This client folds the catalog into the `/mcp` view
            // (the same resolved `services` cards the daemon serves both
            // surfaces), so the command opens that view; an argument
            // prefills its search field like TS's initial search.
            "plugins" => {
                self.open_mcp_view("/plugins", view, "").await?;
                let search = resolved.args.trim();
                if !search.is_empty() {
                    if let Some(mcp) = view.mcp_view.as_mut() {
                        mcp.paste(search);
                    }
                }
            }
            // TS `handleExportCommand`: an explicit `.jsonl` path exports
            // the current branch; anything else (including no argument)
            // exports HTML.
            "export" => {
                self.handle_export_command(resolved, view).await?;
            }
            // TS `handleShareCommand`: an argument is the usage error (the
            // text stays in the editor); otherwise the session exports to a
            // temp file and uploads as a secret gist.
            "share" => {
                if resolved.args.is_empty() {
                    self.handle_share_command(view).await?;
                } else {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /share", view);
                }
            }
            // `/hotkeys` (TS `handleHotkeysCommand` after
            // `echoLocalCommand`): the typed command echoes as a user
            // message block, then the full keyboard-shortcut reference
            // renders from the EFFECTIVE bindings so user
            // `keybindings.json` overrides show their keys. Client-side
            // rows only, never durable session entries.
            "hotkeys" => {
                if !resolved.args.is_empty() {
                    // TS keeps the text in the editor on the usage error.
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /hotkeys", view);
                    return Ok(());
                }
                // The operator's 2026-09-26 directive: the full guide
                // renders as the read-only info panel instead of the
                // multi-screen markdown flood in the transcript (the
                // content itself is unchanged).
                self.open_info_panel(
                    view,
                    Some("Hotkeys".to_string()),
                    InfoContent::Markdown(crate::hotkeys::hotkeys_guide(view.editor.keybindings())),
                );
                self.track_menu_opened("hotkeys", "command");
            }

            // `/session` (TS `handleSessionCommand`): the daemon's
            // session stats as the `Session Info` rows — rendered in the
            // read-only info panel (the operator's 2026-09-26
            // directive), not as transcript rows.
            "session" => {
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /session", view);
                    return Ok(());
                }
                let stats = self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::GetSessionStats {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            rest: Map::default(),
                        },
                    )
                    .await;
                match stats {
                    Ok(stats) => {
                        let name = self.session_name.clone();
                        // The content's own `Session Info` header row is
                        // the panel's head (no title duplication).
                        self.open_info_panel(
                            view,
                            None,
                            InfoContent::Rows(info_commands::session_info_rows(
                                &stats,
                                name.as_deref(),
                            )),
                        );
                        self.track_menu_opened("session", "command");
                    }
                    Err(error) => {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            // `/context` and its `/usage` alias (TS
            // `handleContextCommand` over `formatContextTree`): the agent
            // tree with own token/cost columns and context utilization —
            // rendered in the scrollable read-only info panel (the
            // operator's 2026-09-26 directive), not as transcript rows.
            // The optional `all` argument is #2842's deliberate TS delta
            // (TS takes none): over the row budget the default view
            // collapses to the highest-usage agents plus a summary row
            // and the expand hint, and `all` renders the whole tree.
            "context" => {
                let scope = match resolved.args.as_str() {
                    "" => info_commands::ContextTreeScope::Collapsed,
                    "all" => info_commands::ContextTreeScope::EveryAgent,
                    _ => {
                        view.editor.set_text(text);
                        self.error_row("Usage: /context [all]", view);
                        return Ok(());
                    }
                };
                let tree = self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::GetContextTree {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            rest: Map::default(),
                        },
                    )
                    .await;
                match tree {
                    Ok(tree) => {
                        // TS render width: clamp(columns - 2, 60, 120).
                        let width = terminal_columns().saturating_sub(2).clamp(60, 120);
                        // The content's own `Context` header row is the
                        // panel's head (no title duplication).
                        self.open_info_panel(
                            view,
                            None,
                            InfoContent::Rows(info_commands::context_tree_rows(
                                &tree, width, scope,
                            )),
                        );
                        self.track_menu_opened("context", "command");
                    }
                    Err(error) => {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            // `/system-prompt` (TS `handleSystemPromptCommand`): the header
            // with the char count, then the exact assembled prompt — a
            // document of unbounded size, so it renders in the
            // scrollable read-only info panel (the operator's 2026-09-26
            // directive) instead of flooding the transcript.
            "system-prompt" => {
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /system-prompt", view);
                    return Ok(());
                }
                let prompt = self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::GetSystemPrompt {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            rest: Map::default(),
                        },
                    )
                    .await;
                match prompt {
                    Ok(data) => {
                        let prompt = data
                            .get("systemPrompt")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let mut rows = info_commands::system_prompt_header_rows(prompt);
                        rows.push(Vec::new());
                        rows.extend(info_commands::system_prompt_body_rows(prompt));
                        // The header row (`System Prompt (N chars)`) is
                        // the panel's head.
                        self.open_info_panel(view, None, InfoContent::Rows(rows));
                        self.track_menu_opened("system-prompt", "command");
                    }
                    Err(error) => {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            // `/logs` (TS `handleLogsCommand`): a client-side read of the
            // logs directory (the daemon writes it, this client lists
            // it), rendered in the read-only info panel (the operator's
            // 2026-09-26 directive).
            "logs" => {
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /logs", view);
                    return Ok(());
                }
                let Some(agent_dir) = pa_types::platform::agent_dir() else {
                    self.error_row(
                        "home directory not found: set HOME (or USERPROFILE on Windows)",
                        view,
                    );
                    return Ok(());
                };
                // The content's own `Logs` header row is the panel's
                // head.
                self.open_info_panel(
                    view,
                    None,
                    InfoContent::Rows(info_commands::logs_rows(&agent_dir.join("logs"))),
                );
                self.track_menu_opened("logs", "command");
            }
            // `/changelog` (TS `handleChangelogCommand`): the shipped
            // CHANGELOG.md entries, newest first, in the read-only info
            // panel (the operator's 2026-09-26 directive; the TS accent
            // `What's New` title is the panel's title).
            "changelog" => {
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /changelog", view);
                    return Ok(());
                }
                self.open_info_panel(
                    view,
                    Some("What's New".to_string()),
                    InfoContent::Markdown(info_commands::changelog_markdown(
                        &Self::changelog_path(),
                    )),
                );
                self.track_menu_opened("changelog", "command");
            }
            // `/settings` (TS `showSettingsSelector`): the inline settings
            // menu; the rows read the daemon state and the settings seam.
            "settings" => {
                if !resolved.args.is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /settings", view);
                    return Ok(());
                }
                self.open_settings_menu(view).await;
            }
            // `/btw` (TS `handleSideQuestion` via the submit ladder; `/side`
            // resolves to it): start a side question without touching the
            // session transcript; the pane stays open for follow-ups until
            // esc returns to the main thread.
            "btw" => {
                if resolved.args.is_empty() {
                    self.note_as("Usage: /btw <question>", StatusKind::Warning, view);
                    return Ok(());
                }
                self.start_side_question(&resolved.args, view).await?;
            }
            // `/name` (TS `handleNameCommand`; `/rename` resolves to it):
            // a missing argument reports the current name, otherwise the
            // rename travels to the daemon (`set_session_name` persists
            // the `session_info` entry and broadcasts the change).
            "name" => {
                let name = resolved.args.trim();
                if name.is_empty() {
                    match &self.session_name {
                        Some(current) => self.note(&format!("Session name: {current}"), view),
                        None => self.note_as("Usage: /name <name>", StatusKind::Warning, view),
                    }
                    return Ok(());
                }
                match self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::SetSessionName {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            name: name.to_string(),
                            worker_token: None,
                            rest: Map::default(),
                        },
                    )
                    .await
                {
                    Ok(_) => {
                        self.session_name = Some(name.to_string());
                        view.chrome.chat_name = self.session_display();
                        self.plain_row(&format!("Session name set: {name}"), view);
                    }
                    Err(error) => self.error_row(&format!("{error:#}"), view),
                }
            }
            // `/fast` (TS `handleFastCommand`): toggle the priority service
            // tier on a fast-mode-eligible model; the state refresh after
            // the switch drives the status row.
            "fast" => {
                if !resolved.args.is_empty() {
                    self.error_row("Usage: /fast", view);
                    return Ok(());
                }
                self.handle_fast_command(view).await;
            }
            // `/tier [tier]` (TS `handleTierCommand`): show or set the
            // session service tier.
            "tier" => {
                self.handle_tier_command(view, &resolved.args).await;
            }
            // `/rlm-max-depth` (TS `handleRlmMaxDepthCommand`): view or set
            // the per-chat recursive depth limit.
            "rlm-max-depth" => {
                self.handle_rlm_max_depth_command(view, &resolved.args)
                    .await;
            }
            // `/speed [on|off]` (TS `setSpeedDisplay`): toggle the footer
            // tok/sec readout for this session — the dim dock row with the
            // latest response's rate and the session average.
            "speed" => {
                let arg = resolved.args.trim().to_lowercase();
                if !arg.is_empty() && arg != "on" && arg != "off" {
                    self.error_row("Usage: /speed [on|off]", view);
                    return Ok(());
                }
                let enable = match arg.as_str() {
                    "on" => true,
                    "off" => false,
                    _ => !self.speed_display_enabled,
                };
                self.set_speed_display(enable, view);
            }
            // `/reload` (TS `handleReloadCommand`): the guards first (a
            // streaming turn or compaction defers the reload), then the
            // bordered loader replaces the editor while the daemon and the
            // client re-read their inputs.
            "reload" => {
                if !resolved.args.is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /reload", view);
                    return Ok(());
                }
                if self.turn_active || view.working.is_some() || self.work_in_flight() {
                    self.note_as(
                        "Wait for the current response to finish before reloading.",
                        StatusKind::Warning,
                        view,
                    );
                    return Ok(());
                }
                if view.compaction.is_some() {
                    self.note_as(
                        "Wait for compaction to finish before reloading.",
                        StatusKind::Warning,
                        view,
                    );
                    return Ok(());
                }
                self.handle_reload_command(view)?;
            }
            // `/heartbeats` (TS `showHeartbeatManager`): the inline
            // management view over the session-scoped heartbeat catalog —
            // this session's and its RLM children's user and agent
            // heartbeats. An argument is the TS usage error (the text
            // stays in the editor).
            "heartbeats" => {
                if !resolved.args.is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /heartbeats", view);
                    return Ok(());
                }
                self.open_heartbeats_view(view);
            }
            other => {
                self.note(
                    &format!("/{other} is not available in this client yet"),
                    view,
                );
            }
        }
        Ok(())
    }

    /// Report a menu surface opening (`tui menu opened`, fire-and-forget
    /// like the other adoption seams): `menu` names the surface (`model`,
    /// `mcp`), `source` how it opened (`command`, `tab`).
    pub(super) fn track_menu_opened(&self, menu: &'static str, source: &'static str) {
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.menu_opened(menu, source).await;
            });
        }
    }

    /// Fetch the session's slash-command catalog in the background (TS
    /// `refreshConnectionCatalog`'s `getCommands` arm, best-effort with a
    /// bounded wait like the heartbeat refresh): the response carries the
    /// `skill:` commands the autocomplete provider lists. A fetch races a
    /// rebind silently — the epoch drops the stale response at fold time.
    pub(crate) fn spawn_command_catalog_refresh(&mut self) {
        self.command_refresh_epoch += 1;
        let epoch = self.command_refresh_epoch;
        // TS's rebind completes only after the fresh catalog lands
        // (`refreshConnectionCatalog` is awaited before the provider
        // rebuild), so the menu never serves the previous session's
        // skills. The clear rides the same FIFO channel ahead of the
        // fetch's response (this send completes before the spawn below
        // runs), so the old rows drop immediately and the fresh fetch
        // repopulates — a rebind never offers stale cross-session
        // commands.
        let _ = self.command_updates.send(CommandCatalogUpdate {
            epoch,
            skill_commands: Vec::new(),
        });
        let updates = self.command_updates.clone();
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        tokio::spawn(async move {
            let request = DaemonCommand::GetCommands {
                id: None,
                active_session_id,
                rest: Map::default(),
            };
            let fetched = tokio::time::timeout(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                client.request_ok(request),
            )
            .await;
            let skill_commands = match fetched {
                Ok(Ok(data)) => crate::autocomplete::skill_command_entries(&data),
                // TS `refreshCommandCatalogForCurrentSession` clears the
                // catalog on failure (`connectionCommands = []`); the
                // attach-time fetch keeps nothing either.
                Ok(Err(_)) | Err(_) => Vec::new(),
            };
            let _ = updates.send(CommandCatalogUpdate {
                epoch,
                skill_commands,
            });
        });
    }

    /// Fold a landed command-catalog refresh into the session (TS
    /// `refreshConnectionCatalog` -> `setupAutocompleteProvider`): the
    /// `skill:` commands replace the provider's list — gated by the
    /// `enableSkillCommands` setting (TS default true) — and a stale
    /// epoch never applies.
    pub(crate) fn apply_command_catalog(
        &mut self,
        update: CommandCatalogUpdate,
        view: &mut AgentView,
    ) {
        if update.epoch < self.command_refresh_epoch {
            return;
        }
        // The cache keeps the raw fetch (the toggle re-applies it under
        // the setting's new value); the setting gates only what the
        // provider lists. The TS default (true) applies when the
        // composition root supplies no settings seam.
        self.skill_commands_cache = update.skill_commands;
        let skills = if self
            .client_settings
            .as_ref()
            .is_none_or(|settings| settings.enable_skill_commands())
        {
            self.skill_commands_cache.clone()
        } else {
            Vec::new()
        };
        view.editor.set_autocomplete_skill_commands(skills);
        self.dirty = true;
    }

    /// The session's connection state (TS `AgentConnectionState`): the
    /// worker's `get_connection_state` response, which carries the
    /// connection fields (`availableThinkingLevels`, `thinkingLevel`,
    /// `steeringMode`, `serviceTier`, ...) — `get_state` serves the
    /// roster summary instead. `None` surfaces the failure as a note;
    /// callers keep the transcript unchanged then.
    pub(super) async fn connection_state(&mut self, view: &mut AgentView) -> Option<Value> {
        match self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetConnectionState {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await
        {
            Ok(data) => {
                // The queue delivery mode rides the state (TS
                // `steeringMode`): cached here — every state read is the
                // single refresh seam — so the queued-input adoption
                // event reports the live mode without a fetch.
                if let Some(mode) = data.get("steeringMode").and_then(Value::as_str) {
                    self.steering_mode = mode.to_string();
                }
                Some(data)
            }
            Err(error) => {
                self.note(&format!("{error:#}"), view);
                None
            }
        }
    }
}
