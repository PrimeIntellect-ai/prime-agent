//! The status-row concern: the note/toast/error-row rendering family
//! (TS `showStatus`/`showError`), the tray rebuild, the goal-tray
//! glue, and the anthropic-subscription warning pair that rides it.
use super::{
    format_goal_status, terminal_columns, AgentView, ChatEntry, DaemonCommand, Duration, Map,
    SessionUi, StatusKind, Value, ANTHROPIC_SUBSCRIPTION_AUTH_WARNING, UI_REQUEST_TIMEOUT_MS,
};

impl SessionUi {
    /// One `goal_update` session event (TS `handleGoalUpdate`): store the
    /// state, announce as a status row when the dedupe rules say so, and
    /// sync the tray goal label.
    pub(super) fn apply_goal_update(&mut self, goal: Value, view: &mut AgentView) {
        let Ok(goal) = serde_json::from_value::<pa_types::goal::GoalState>(goal) else {
            return;
        };
        let announce = self.goal_view.apply_update(goal.clone());
        if announce {
            self.announce_goal_status(view);
        }
        // An open goal panel rides the live state, never a stale
        // snapshot of the objective it was opened to show.
        if let Some(panel) = view.goal_panel.as_mut() {
            panel.goal = goal;
        }
        self.sync_goal_tray(view);
    }

    /// The goal status row (TS `showStatus` via `formatGoalStatus`): a
    /// consecutive announcement rewrites the previous status row in place
    /// while it is still the transcript's last entry.
    fn announce_goal_status(&mut self, view: &mut AgentView) {
        let columns = terminal_columns();
        let text = format_goal_status(&self.goal_view.goal, columns);
        let updated_in_place = match self.goal_view.last_status_index {
            Some(index) if index + 1 == view.chat_len() => {
                view.update_status_row(index, &text, StatusKind::Info)
            }
            _ => false,
        };
        if !updated_in_place {
            view.push_entry(ChatEntry::Status {
                text,
                kind: StatusKind::Info,
            });
            self.goal_view.last_status_index = Some(view.chat_len() - 1);
        }
        self.dirty = true;
    }

    /// The goal's dock row follows the current goal state (the tray's
    /// TS `getTrayGoalLabel` cluster is deliberately not ported — the
    /// operator's 2026-09-24 directive moves "Pursuing goal" off the
    /// line below the prompt bar; the dock's row below carries it).
    pub(crate) fn sync_goal_tray(&mut self, view: &mut AgentView) {
        let previous = view.chrome.activity.clone();
        self.update_subagent_summary(view);
        if previous != view.chrome.activity {
            self.dirty = true;
        }
    }

    /// Re-apply the refreshed context usage to the chrome state.
    pub(crate) fn rebuild_tray(&mut self, view: &mut AgentView) {
        view.chrome.context = self.context;
        view.chrome.chat_name = self.session_display();
        self.dirty = true;
    }

    pub(crate) fn note(&mut self, text: &str, view: &mut AgentView) {
        self.note_as(text, StatusKind::Info, view);
    }

    /// Show an ephemeral action toast (the top-right auto-dismiss overlay;
    /// a sanctioned divergence from TS — see `toast`): the confirmation
    /// never lands in the transcript, and the frame repaints so the
    /// overlay appears at once (its expiry repaints it away).
    pub(crate) fn toast(&mut self, text: &str, view: &mut AgentView) {
        view.toasts.push(text);
        self.dirty = true;
    }

    /// A plain appended dim row (TS `chatContainer.addChild(new
    /// Markdown/Text(...))` — `/name` and `/rlm-max-depth` report rows):
    /// unlike `note` it never rewrites the previous status in place, so
    /// back-to-back rows stack like the TS plain rows.
    pub(crate) fn plain_row(&mut self, text: &str, view: &mut AgentView) {
        view.push_entry(ChatEntry::Status {
            text: text.to_string(),
            kind: StatusKind::Info,
        });
        self.last_status_index = None;
        self.dirty = true;
    }

    /// TS `showStatus` with a tone: the same back-to-back in-place rewrite
    /// as [`Self::note`], with the row's kind following the TS tone.
    pub(crate) fn note_as(&mut self, text: &str, kind: StatusKind, view: &mut AgentView) {
        // TS `showStatus`: a status emitted back-to-back (nothing else
        // reached the chat since the previous one) rewrites the previous
        // status row in place instead of appending a new one.
        let updated_in_place = match self.last_status_index {
            Some(index) if index + 1 == view.chat_len() => {
                view.update_status_row(index, text, kind.clone())
            }
            _ => false,
        };
        if !updated_in_place {
            view.push_entry(ChatEntry::Status {
                text: text.to_string(),
                kind,
            });
            self.last_status_index = Some(view.chat_len() - 1);
        }
        self.dirty = true;
    }

    /// TS `maybeWarnAboutAnthropicSubscriptionAuth`'s login-completed
    /// slice (`onLoginCompleted`): a COMPLETED Anthropic subscription
    /// login draws the ban-risk warning, gated by the settings toggle
    /// (`warnings.anthropicExtraUsage`, TS default true — an absent
    /// settings seam keeps the warning ENABLED).
    ///
    /// Operator directive 2026-09-29 (the TS delta this arm carries): a
    /// fresh auth landing RE-WARNS — the login-completed slice is NOT
    /// gated by the once-per-session-lifecycle marker (each completed
    /// subscription login is its own landing, the user just re-proved the
    /// credential shape), so the per-instance dedup flag drops out of this
    /// arm's gate. The marker is still marked
    /// ([`Self::mark_anthropic_warning_shown`]), so a later open of this
    /// session does not draw a second copy.
    /// The warning STACKS — `note_as` would rewrite the just-shown
    /// login-success row in place — and carries the same `⚠` prefix as
    /// the credential-detection arm.
    pub(crate) fn maybe_warn_anthropic_subscription_auth(
        &mut self,
        provider: &str,
        view: &mut AgentView,
    ) {
        if provider != crate::provider_auth::ANTHROPIC_PROVIDER_ID
            || !self
                .client_settings
                .as_ref()
                .is_none_or(|settings| settings.warnings_anthropic_extra_usage())
        {
            return;
        }
        self.anthropic_subscription_warning_shown = true;
        self.mark_anthropic_warning_shown();
        view.push_entry(ChatEntry::Status {
            text: format!("\u{26a0} {ANTHROPIC_SUBSCRIPTION_AUTH_WARNING}"),
            kind: StatusKind::Warning,
        });
        self.last_status_index = None;
        self.dirty = true;
    }

    /// The credential-detection arm of TS
    /// `maybeWarnAboutAnthropicSubscriptionAuth` (#2645): the startup,
    /// model-selection, and api-key-save triggers need the ACTIVE
    /// CREDENTIAL's shape — the composition root's
    /// [`ProviderAuthCommands::anthropic_subscription_warning`] resolves
    /// it (a stored `Oauth` credential or an `sk-ant-oat` key is the
    /// subscription; a plain API key never warns). The login-completed
    /// slice — where the just-settled subscription OAuth login itself
    /// proves the shape — lives in
    /// [`Self::maybe_warn_anthropic_subscription_auth`]. Both share the
    /// `warnings.anthropicExtraUsage` setting.
    ///
    /// Operator directive 2026-09-29 (the TS delta this arm carries): the
    /// warning fires once per SESSION LIFECYCLE, not once per TUI
    /// instance — the per-instance flag stays as this view's own dedup,
    /// but the real gate is the session's persisted marker read from the
    /// daemon ([`Self::anthropic_warning_already_shown`]): a reattach or
    /// a resume of a session that already drew the warning skips it, a
    /// genuinely new session draws it once (and marks it shown). The
    /// check runs LAST — after the settings toggle, the provider, and
    /// the credential shape resolved an actual pending warning — so the
    /// extra `get_state` round trip never happens for sessions that
    /// would not warn anyway, and it fails OPEN (an absent field from an
    /// older daemon, or an unreadable state, draws the warning rather
    /// than suppressing it).
    /// The once-per-installation telemetry disclosure (TS
    /// agent-session-services): the interactive session renders it as an
    /// info row — the alt screen hides any pre-TUI stderr print, so the
    /// row is the only shape the user actually sees — and the shown
    /// marker persists the moment the row renders (TS
    /// `setTelemetryNoticeShown`).
    pub(crate) fn maybe_show_telemetry_notice(&mut self, view: &mut AgentView) {
        let Some(settings) = self.client_settings.clone() else {
            return;
        };
        if !settings.telemetry_notice_due() {
            return;
        }
        view.push_entry(ChatEntry::Status {
            // The same disclosure text the print-mode notice carries
            // (pa-cli `telemetry_notice`), plus the interactive switch.
            text: "Prime Agent sends pseudonymous usage and performance metrics without prompts, responses, tool content, file paths, or repository data. Disable this with /telemetry off, telemetry.enabled=false, PRIME_AGENT_TELEMETRY=0, DO_NOT_TRACK=1, or offline mode."
                .to_string(),
            kind: StatusKind::Info,
        });
        let _ = settings.set_telemetry_notice_shown();
        self.dirty = true;
    }

    pub(crate) async fn maybe_warn_anthropic_subscription_auth_if_subscribed(
        &mut self,
        provider: Option<&str>,
        view: &mut AgentView,
    ) {
        if self.anthropic_subscription_warning_shown {
            return;
        }
        let warnings_enabled = self
            .client_settings
            .as_ref()
            .is_none_or(|settings| settings.warnings_anthropic_extra_usage());
        if !warnings_enabled || provider != Some("anthropic") {
            return;
        }
        let Some(auth) = self.provider_auth.clone() else {
            return;
        };
        if let Some(warning) = auth.0.anthropic_subscription_warning().await {
            if self.anthropic_warning_already_shown().await {
                // This session already drew the warning somewhere (this
                // view attaches to, or resumes, a session that warned
                // before): hold the view-local gate too, so a later
                // model switch in THIS instance costs no further reads.
                self.anthropic_subscription_warning_shown = true;
                return;
            }
            self.anthropic_subscription_warning_shown = true;
            self.mark_anthropic_warning_shown();
            // The warning STACKS, never rewrites: `note_as` would replace
            // the just-shown `Model: ...` or login-success confirmation
            // row in place (TS `showStatus`'s back-to-back rewrite); a
            // plain pushed row keeps both, and clearing the status index
            // keeps the NEXT status from rewriting the warning either.
            view.push_entry(ChatEntry::Status {
                text: format!("\u{26a0} {warning}"),
                kind: StatusKind::Warning,
            });
            self.last_status_index = None;
            self.dirty = true;
        }
    }

    /// The session's persisted once-per-lifecycle gate (operator
    /// directive 2026-09-29): whether THIS session has already drawn the
    /// Anthropic subscription ban-risk warning — the daemon's `get_state`
    /// carries `anthropicWarningShown`, hydrated from the session file's
    /// marker row, so every view of the session (a reattach, a resume, a
    /// fresh process) reads the same truth. Best-effort and fail-open: an
    /// unreadable state, or a field an older daemon never emits, answers
    /// `false` — the warning shows rather than being suppressed by a
    /// failed read.
    async fn anthropic_warning_already_shown(&mut self) -> bool {
        self.bounded_request(
            Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
            DaemonCommand::GetState {
                id: None,
                active_session_id: self.active_session_id.clone(),
                rest: Map::default(),
            },
        )
        .await
        .ok()
        .and_then(|state| {
            state
                .get("anthropicWarningShown")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
    }

    /// Persist the session's once-per-lifecycle marker with the daemon
    /// (`mark_anthropic_warning_shown`): fire-and-forget and bounded — the
    /// durable row is never a render dependency; a failed or
    /// unacknowledged mark costs one repeated warning on this session's
    /// next open, never a suppressed one.
    fn mark_anthropic_warning_shown(&self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let pending = self.anthropic_warning_mark_pending.clone();
        pending.store(true, std::sync::atomic::Ordering::Release);
        tokio::spawn(async move {
            let _ = tokio::time::timeout(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                client.request_ok(DaemonCommand::MarkAnthropicWarningShown {
                    id: None,
                    active_session_id,
                    rest: Map::default(),
                }),
            )
            .await;
            pending.store(false, std::sync::atomic::Ordering::Release);
        });
    }

    /// Whether the session's `mark_anthropic_warning_shown` write is still
    /// in flight (the headless exit gate holds the run until the durable
    /// write resolves — the mark is never a render dependency, but a
    /// scripted run must not end with it un-acked).
    pub(crate) fn anthropic_warning_mark_pending(&self) -> bool {
        self.anthropic_warning_mark_pending
            .load(std::sync::atomic::Ordering::Acquire)
    }

    /// The TS `showError` row: `⚠ Error: <message>` in the error color.
    pub(crate) fn error_row(&mut self, message: &str, view: &mut AgentView) {
        view.push_entry(ChatEntry::Status {
            text: format!("\u{26a0} Error: {message}"),
            kind: StatusKind::Error,
        });
        self.dirty = true;
    }
}
