//! The share concern: the `/update`, `/traces`, `/copy`, `/export`, and
//! `/share` runs — the spawned one-way tasks and their note outcomes.
use super::*;

/// The `/share` upload task's report: the created gist or the failure
/// message (TS resolves the same promise from the gh process result).
pub(crate) type ShareNote = Result<GistOutcome, String>;

/// The background `/update` run's report: the new build's version line,
/// or the failure message (the same funnel `prime-agent update` runs —
/// the runner the composition root owns).
pub(crate) type UpdateNote = std::result::Result<String, String>;

/// The `/traces upload-all` sweep's reports: the live progress counter and
/// the settled summary (TS `onProgress`'s status row + the arm's awaited
/// result).
pub(crate) type TracesUploadNote = crate::traces::TraceUploadAllNote;

/// A `/share` upload in flight: the abortable task and the temp export.
pub(crate) struct ShareRun {
    /// The upload task; aborting it kills `gh` (`kill_on_drop`).
    task: tokio::task::JoinHandle<()>,
    /// The temp HTML export `gh gist create` uploads (removed on settle).
    tmp_file: std::path::PathBuf,
}

/// A `/traces upload-all` run in flight (TS the arm's
/// `traceUploadAllAbortController` + the awaited sweep).
pub(super) struct TraceUploadAllRun {
    /// The sweep task; aborting it drops the engine's requests mid-flight
    /// (the engine's own cancel keeps the sleeps and workers bounded).
    task: tokio::task::JoinHandle<()>,
    /// The cancel handle the clear key fires (TS `app.clear` → abort).
    pub(super) cancel: crate::traces::TraceUploadCancel,
}

/// Why the parked traces login runs: the `login` arm, or the `on` arm's
/// credential-less entry (TS `handleTracesCommand` runs the login flow
/// inline, then continues the enable).
pub(super) enum TracesLoginIntent {
    Login,
    Enable,
}

impl SessionUi {
    // ------------------------------------------------------------------
    // Update (/update)
    // ------------------------------------------------------------------

    /// The confirmed update: spawn the download+install OUT-OF-BAND. The
    /// run replaces only the on-disk binary (the running binary is
    /// in-memory — replacing it is safe), so nothing here blocks or tears
    /// down: the TUI stays mounted, the daemon keeps running, and the
    /// outcome lands as a row through [`Self::update_notes`] when the
    /// task finishes.
    pub(super) fn spawn_update(&mut self, view: &mut AgentView) {
        let Some(update) = self.update_commands.clone() else {
            self.note("/update is not available in this client yet", view);
            return;
        };
        let notes = self.update_notes.clone();
        self.update_in_flight = true;
        self.note(
            "Updating — downloading and installing the latest Rust build…",
            view,
        );
        tokio::spawn(async move {
            let outcome = update.0.run_update().await;
            let _ = notes.send(outcome);
        });
    }

    /// The background update run's landed outcome: the success row names
    /// the new build (restart runs it — the running binary keeps serving
    /// this session until then), else the error row carries the
    /// installer's failure.
    pub(crate) fn apply_update_note(&mut self, outcome: UpdateNote, view: &mut AgentView) {
        self.update_in_flight = false;
        match outcome {
            Ok(version) => {
                self.note(
                    &format!("updated to {version} — restart prime-agent to run it"),
                    view,
                );
            }
            Err(message) => {
                self.error_row(&message, view);
            }
        }
    }

    // ------------------------------------------------------------------
    // Trace sharing (/traces)
    // ------------------------------------------------------------------

    /// `/traces [status|on|off|preview|upload|upload-current|upload-all|
    /// login]` (TS `handleTracesCommand`): the status block, the
    /// enable/disable settings writes, the preview, the one-shot upload,
    /// the upload-all sweep, and the terminal login — the full TS command
    /// family over the composition root's trace engine.
    pub(crate) async fn handle_traces_command(
        &mut self,
        resolved: &pa_types::slash_commands::ResolvedSlashCommand,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(traces) = self.traces.clone() else {
            self.note("/traces is not available in this client yet", view);
            return Ok(());
        };
        let command = resolved.args.trim().to_lowercase();
        // TS reads the connection state for the session file (and the
        // upload-all sweep for the session dir).
        let state = self.connection_state(view).await;
        let state_field = |name: &str| {
            state
                .as_ref()
                .and_then(|state| state.get(name))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let session_file = state_field("sessionFile");
        let session_dir = state_field("sessionDir");
        match command.as_str() {
            "" | "status" => {
                // TS `settingsManager.reload()` then the block: the
                // fresh-manager reads are the reload's post-state.
                let enabled = traces.0.enabled().await;
                let credential = traces.0.credential().await;
                let rows = crate::traces::status_block(
                    enabled,
                    credential.as_deref(),
                    session_file.as_deref(),
                    &crate::traces::traces_base_url(),
                );
                // The info-display rows the `/session`-style commands
                // share — in the read-only info panel (the operator's
                // 2026-09-26 directive), never as transcript rows.
                self.open_info_panel(view, None, InfoContent::Rows(rows));
                self.track_menu_opened("traces", "command");
            }
            "off" | "disable" => {
                // TS `setAgentTracesEnabled(false)` + `flush()`, then the
                // status row.
                if let Err(error) = traces.0.set_enabled(false).await {
                    self.error_row(
                        &format!("Trace sharing disabled write failed: {error:#}"),
                        view,
                    );
                    return Ok(());
                }
                self.note("Trace sharing disabled.", view);
            }
            "on" | "enable" => {
                // TS the enable arm: a missing credential runs the login
                // flow first (the run loop parks it on the plain
                // terminal); a cancelled or failed login stops here.
                let credential = traces.0.credential().await;
                if credential.is_none() {
                    self.pending_traces_login = Some(TracesLoginIntent::Enable);
                    return Ok(());
                }
                self.enable_traces(&traces, session_file.as_deref(), view)
                    .await?;
            }
            "preview" => {
                // TS `previewCurrentTrace`: the block, or the fallback
                // status rows.
                match traces.0.preview(session_file.as_deref()).await {
                    crate::traces::TracePreviewOutcome::Ready(info) => {
                        let rows = crate::traces::preview_block(&info);
                        // The preview block's own `Trace Preview`
                        // header row is the panel's head.
                        self.open_info_panel(view, None, InfoContent::Rows(rows));
                        self.track_menu_opened("traces", "command");
                    }
                    crate::traces::TracePreviewOutcome::NoSessionFile => {
                        self.note(
                            "Trace preview is unavailable until the current session has a persisted assistant response.",
                            view,
                        );
                    }
                    crate::traces::TracePreviewOutcome::EmptySession => {
                        self.note("The current trace is empty.", view);
                    }
                    crate::traces::TracePreviewOutcome::Invalid { message }
                    | crate::traces::TracePreviewOutcome::Failed { message } => {
                        self.note(&format!("Trace preview failed: {message}."), view);
                    }
                }
            }
            "upload" | "upload-current" => {
                // TS the one-shot upload: the credential gate, then the
                // formatted row (a failure is the error row).
                let credential = traces.0.credential().await;
                if credential.is_none() {
                    self.error_row(
                        "Trace sharing needs a Prime API key. Run /traces login.",
                        view,
                    );
                    return Ok(());
                }
                let report = traces.0.upload_current(session_file.as_deref()).await;
                if report.status == crate::traces::TraceUploadStatus::Failed {
                    self.error_row(&report.text, view);
                } else {
                    self.note(&report.text, view);
                }
            }
            "upload-all" => {
                // TS the sweep: the credential gate, the one-sweep-at-a-
                // time guard, then the background run (progress through
                // the note channel, the clear key cancels).
                let credential = traces.0.credential().await;
                if credential.is_none() {
                    self.error_row(
                        "Trace sharing needs a Prime API key. Run /traces login.",
                        view,
                    );
                    return Ok(());
                }
                if self.trace_upload.is_some() {
                    self.note_as(
                        "A trace upload is already running. Cancel it before starting another.",
                        StatusKind::Warning,
                        view,
                    );
                    return Ok(());
                }
                let notes = self.traces_upload_notes.clone();
                let cancel = crate::traces::TraceUploadCancel::new();
                let run_cancel = cancel.clone();
                let handle = traces.clone();
                let task = tokio::spawn(async move {
                    let report = handle
                        .0
                        .upload_all(session_dir.as_deref(), notes.clone(), run_cancel.clone())
                        .await;
                    let _ = notes.send(crate::traces::TraceUploadAllNote::Done {
                        result: report,
                        cancelled: run_cancel.is_cancelled(),
                    });
                });
                self.trace_upload = Some(TraceUploadAllRun { task, cancel });
            }
            "login" => {
                // TS runs the login dialog; the terminal port parks the
                // flow against the inline auth panel (the run loop mounts
                // it right after this key).
                self.pending_traces_login = Some(TracesLoginIntent::Login);
            }
            _ => {
                self.note_as(
                    "Usage: /traces [status|on|off|preview|upload|upload-current|upload-all|login]",
                    StatusKind::Warning,
                    view,
                );
            }
        }
        Ok(())
    }

    /// TS the enable arm's tail (after the credential): set the flag,
    /// flush, then the one-shot upload whose message rides the status
    /// row.
    async fn enable_traces(
        &mut self,
        traces: &crate::traces::TracesCommandsHandle,
        session_file: Option<&str>,
        view: &mut AgentView,
    ) -> Result<()> {
        if let Err(error) = traces.0.set_enabled(true).await {
            self.error_row(
                &format!("Trace sharing enabled write failed: {error:#}"),
                view,
            );
            return Ok(());
        }
        let report = traces.0.upload_current(session_file).await;
        self.note(
            &format!("Trace sharing enabled. {}", report.enable_message()),
            view,
        );
        Ok(())
    }

    /// Whether a parked `/traces login` waits for the panel mount (the
    /// run loop checks this after each key).
    pub(crate) fn pending_traces_login(&self) -> bool {
        self.pending_traces_login.is_some()
    }

    /// The parked traces login: mount the inline auth panel (TS the
    /// login dialog mounts as the flow starts) and spawn the flow against
    /// it; the settled outcome folds in through the panel channel and
    /// continues the enable intent (TS's `on` arm).
    pub(crate) fn run_traces_login(&mut self, view: &mut AgentView) {
        // The park is consumed here (the intent moves to the in-flight
        // run): the key-path check spawns the flow exactly once.
        let Some(intent) = self.pending_traces_login.take() else {
            return;
        };
        let Some(traces) = self.traces.clone() else {
            return;
        };
        self.traces_login_run = Some(intent);
        self.traces_login_gen += 1;
        let gen = self.traces_login_gen;
        let panel = crate::auth_panel::AuthPanelHandle::new(self.auth_panel_notes.clone());
        let mut traces_dialog = crate::auth_panel::AuthPanel::new("Login to Prime Agent Traces");
        traces_dialog.set_cancel_signal(panel.cancel_signal());
        view.auth_panel = Some(traces_dialog);
        tokio::spawn(async move {
            let outcome = traces.0.login(panel.clone()).await;
            panel.send(crate::auth_panel::AuthPanelRequest::TracesSettled { outcome, gen });
        });
    }

    /// A settled traces login (the panel channel's `TracesSettled`): the
    /// outcome row lands, and the enable intent continues TS's `on` arm.
    pub(crate) async fn finish_traces_login(
        &mut self,
        outcome: crate::traces::TraceLoginOutcome,
        view: &mut AgentView,
    ) {
        let intent = self.traces_login_run.take();
        let Some(traces) = self.traces.clone() else {
            return;
        };
        match outcome {
            crate::traces::TraceLoginOutcome::Status(message) => {
                self.note(&message, view);
                if matches!(intent, Some(TracesLoginIntent::Enable)) {
                    // TS re-reads the credential after the login: still
                    // none is the TS error row; a resolved one continues
                    // the enable (set, flush, upload once).
                    let credential = traces.0.credential().await;
                    if credential.is_none() {
                        self.error_row("Trace sharing needs a Prime API key.", view);
                    } else {
                        let state = self.connection_state(view).await;
                        let session_file = state
                            .as_ref()
                            .and_then(|state| state.get("sessionFile"))
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if let Err(error) = self
                            .enable_traces(&traces, session_file.as_deref(), view)
                            .await
                        {
                            self.error_row(&format!("{error:#}"), view);
                        }
                    }
                }
            }
            crate::traces::TraceLoginOutcome::Error(message) => {
                self.error_row(&message, view);
            }
            // A cancelled login stays silent (TS the cancelled dialog
            // shows no row).
            crate::traces::TraceLoginOutcome::Cancelled => {}
        }
        self.dirty = true;
    }

    /// Whether a `/traces upload-all` sweep is in flight (the run loop
    /// must not end before its outcome row lands).
    pub(crate) fn traces_upload_pending(&self) -> bool {
        self.trace_upload.is_some()
    }

    /// One upload-all note (the run loop folds it in): the live counter
    /// rewrites the status row in place (TS `showStatus`), the settled
    /// run reports TS's summary (or the cancel row).
    pub(crate) fn apply_traces_upload_note(
        &mut self,
        note: crate::traces::TraceUploadAllNote,
        view: &mut AgentView,
    ) {
        match note {
            crate::traces::TraceUploadAllNote::Progress { completed, total } => {
                let key = view.editor.keybindings().key_text("app.clear");
                self.note(
                    &format!("Uploading traces: {completed}/{total} ({key} to cancel)"),
                    view,
                );
            }
            crate::traces::TraceUploadAllNote::Done { result, cancelled } => {
                // A late outcome after the run went away is ignored (the
                // sweep was superseded); the settled run's task is
                // reaped here.
                let Some(run) = self.trace_upload.take() else {
                    return;
                };
                // Aborting the task cancels the engine's sweep the same
                // way the handle does; the outcome note still folds in.
                run.task.abort();
                if cancelled {
                    self.note("Trace upload cancelled.", view);
                    return;
                }
                if result.total == 0 {
                    self.note("No persisted traces were found.", view);
                    return;
                }
                // TS's summary: the uploaded count, the optional skipped
                // and failed counts, then the stored bytes.
                let mut parts = vec![format!(
                    "Uploaded {} of {} traces",
                    crate::traces::thousands(result.uploaded as u64),
                    crate::traces::thousands(result.total as u64)
                )];
                if result.skipped > 0 {
                    parts.push(format!(
                        "{} skipped",
                        crate::traces::thousands(result.skipped as u64)
                    ));
                }
                if result.failed > 0 {
                    parts.push(format!(
                        "{} failed",
                        crate::traces::thousands(result.failed as u64)
                    ));
                }
                parts.push(format!(
                    "{} bytes stored",
                    crate::traces::thousands(result.bytes_stored)
                ));
                let summary = parts.join("; ");
                if result.failed > 0 {
                    self.note_as(
                        &format!("{summary}. See {} for details.", result.log_path),
                        StatusKind::Warning,
                        view,
                    );
                } else {
                    self.note(&format!("{summary}."), view);
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Clipboard (/copy)
    // ------------------------------------------------------------------

    /// `/copy` (TS `handleCopyCommand`): fetch the last assistant text
    /// from the daemon and copy it to the clipboard. No assistant text
    /// yet is the TS error row; a clipboard failure surfaces the copy
    /// chain's own message.
    pub(crate) async fn handle_copy_command(&mut self, view: &mut AgentView) -> Result<()> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetLastAssistantText {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await?;
        let text = data
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        let Some(text) = text else {
            self.error_row("No agent messages to copy yet.", view);
            return Ok(());
        };
        match crate::clipboard::copy_to_clipboard(&text, &mut self.osc_sink) {
            Ok(()) => self.toast("Copied last agent message to clipboard", view),
            Err(message) => self.error_row(&message, view),
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // Session export and share (/export, /share)
    // ------------------------------------------------------------------

    /// `/export [path]` (TS `handleExportCommand`): export the session to
    /// HTML — or, for an explicit `.jsonl` path, the current branch as a
    /// JSONL file — and report the written path. The daemon owns the
    /// export; failures surface as the TS error row.
    pub(crate) async fn handle_export_command(
        &mut self,
        resolved: &pa_types::slash_commands::ResolvedSlashCommand,
        view: &mut AgentView,
    ) -> Result<()> {
        let command_text = if resolved.args.is_empty() {
            "/export".to_string()
        } else {
            format!("/export {}", resolved.args)
        };
        let output_path = export_share::path_command_argument(&command_text, "/export");
        let request = if output_path.as_deref().is_some_and(|path| {
            std::path::Path::new(path)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
        }) {
            DaemonCommand::ExportJsonl {
                id: None,
                active_session_id: self.active_session_id.clone(),
                output_path,
                rest: Map::default(),
            }
        } else {
            DaemonCommand::ExportHtml {
                id: None,
                active_session_id: self.active_session_id.clone(),
                output_path,
                rest: Map::default(),
            }
        };
        match self
            .bounded_request(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), request)
            .await
        {
            Ok(data) => {
                let path = data.get("path").and_then(Value::as_str).unwrap_or_default();
                self.note(&format!("Session exported to: {path}"), view);
            }
            Err(error) => {
                self.error_row(&format!("Failed to export session: {error:#}"), view);
            }
        }
        Ok(())
    }

    /// `/share` (TS `handleShareCommand`): gate on the GitHub CLI, export
    /// the session to a temp file, then upload it as a secret gist while
    /// the cancellable loader replaces the editor.
    pub(crate) async fn handle_share_command(&mut self, view: &mut AgentView) -> Result<()> {
        match export_share::probe_gh_auth() {
            GhAuthStatus::NotLoggedIn => {
                self.error_row(
                    "GitHub CLI is not logged in. Run 'gh auth login' first.",
                    view,
                );
                return Ok(());
            }
            GhAuthStatus::NotInstalled => {
                self.error_row(
                    "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/",
                    view,
                );
                return Ok(());
            }
            GhAuthStatus::Ok => {}
        }
        // The temp export `gh` uploads (TS `os.tmpdir()/session.html`).
        let tmp_file = std::env::temp_dir().join("session.html");
        let export = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::ExportHtml {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    output_path: Some(tmp_file.to_string_lossy().into_owned()),
                    rest: Map::default(),
                },
            )
            .await;
        if let Err(error) = export {
            self.error_row(&format!("Failed to export session: {error:#}"), view);
            return Ok(());
        }
        // The upload runs in the background: the loader keeps the UI live,
        // the run loop folds the outcome in when it lands.
        let child = match export_share::spawn_gist_create(&tmp_file) {
            Ok(child) => child,
            Err(error) => {
                let _ = std::fs::remove_file(&tmp_file);
                self.error_row(&format!("Failed to create gist: {error}"), view);
                return Ok(());
            }
        };
        let notes = self.share_notes.clone();
        let task = tokio::spawn(async move {
            let outcome = export_share::gist_outcome(child).await;
            let _ = notes.send(outcome);
        });
        self.share = Some(ShareRun {
            task,
            tmp_file: tmp_file.clone(),
        });
        view.share_loader = Some(ShareLoader::new());
        self.dirty = true;
        Ok(())
    }

    /// Whether a `/share` upload is in flight (the run loop must not end
    /// before its outcome row lands).
    pub(crate) fn share_pending(&self) -> bool {
        self.share.is_some()
    }

    /// A `/share` upload settled: drop the loader, clean the temp file, and
    /// surface the TS rows — the share URL, or the failure. A late outcome
    /// after a cancel is ignored (the run is gone, the cancel showed its
    /// own row).
    pub(crate) fn apply_share_outcome(&mut self, outcome: ShareNote, view: &mut AgentView) {
        let Some(run) = self.share.take() else {
            return;
        };
        view.share_loader = None;
        let _ = std::fs::remove_file(&run.tmp_file);
        match outcome {
            Ok(gist) => {
                self.note(
                    &format!("Share URL: {}\nGist: {}", gist.preview_url, gist.gist_url),
                    view,
                );
            }
            Err(message) => {
                self.error_row(&format!("Failed to create gist: {message}"), view);
            }
        }
        self.dirty = true;
    }

    /// One key press while the `/share` loader is open (TS
    /// `CancellableLoader`): the cancel binding aborts the upload, every
    /// other key is the loader's.
    pub(crate) async fn handle_share_loader_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        if let Some(id) = key_event_to_id(&key) {
            let kb = view.editor.keybindings();
            if kb.matches(&id, "tui.select.cancel") {
                if let Some(run) = self.share.take() {
                    // Aborting the task drops the child and kills `gh`
                    // (kill-on-drop); the temp file goes with the run.
                    run.task.abort();
                    let _ = std::fs::remove_file(&run.tmp_file);
                }
                view.share_loader = None;
                self.note("Share cancelled", view);
            }
        }
        self.dirty = true;
        Ok(())
    }
}
