//! The status-row concern: the note/toast/error-row rendering family
//! (TS `showStatus`/`showError`), the tray rebuild, the goal-tray
//! glue, and the anthropic-subscription warning pair that rides it.
use super::*;

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

    /// Re-apply the refreshed context usage and cost to the chrome state.
    pub(crate) fn rebuild_tray(&mut self, view: &mut AgentView) {
        view.chrome.context = self.context;
        view.chrome.cost_usd = self.cost_usd;
        view.chrome.subagents_cost_usd = self.subagents_cost_usd;
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
    /// login draws the ban-risk warning once per session, gated by the
    /// settings toggle (`warnings.anthropicExtraUsage`, TS default
    /// true — an absent settings seam keeps the warning ENABLED).
    /// The warning STACKS — `note_as` would rewrite the just-shown
    /// login-success row in place — and carries the same `⚠` prefix as
    /// the credential-detection arm.
    pub(crate) fn maybe_warn_anthropic_subscription_auth(
        &mut self,
        provider: &str,
        view: &mut AgentView,
    ) {
        if provider != crate::provider_auth::ANTHROPIC_PROVIDER_ID
            || self.anthropic_subscription_warning_shown
            || !self
                .client_settings
                .as_ref()
                .is_none_or(|settings| settings.warnings_anthropic_extra_usage())
        {
            return;
        }
        self.anthropic_subscription_warning_shown = true;
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
    /// once-per-run gate and the `warnings.anthropicExtraUsage` setting.
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
            self.anthropic_subscription_warning_shown = true;
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

    /// The TS `showError` row: `⚠ Error: <message>` in the error color.
    pub(crate) fn error_row(&mut self, message: &str, view: &mut AgentView) {
        view.push_entry(ChatEntry::Status {
            text: format!("\u{26a0} Error: {message}"),
            kind: StatusKind::Error,
        });
        self.dirty = true;
    }
}
