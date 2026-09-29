//! The panels concern: the activity dock and its group views, the
//! roster-driven subagent summary, the goal and info panels, and the
//! retry-episode collapse (TS `activityBar` composition + panel keys).

use super::{
    key_event_to_id, mpsc, paused_heartbeat_count, picker_viewport_rows, tray_goal_label,
    AgentView, BashActivityUpdate, CommandCatalogUpdate, DaemonCommand, DockFocusSource, GoalPanel,
    HeartbeatsUpdate, InfoContent, InfoPanelAction, KeyEvent, Map, Result, SessionUi, Value,
};

pub(crate) struct ActivityUpdates {
    pub heartbeats: mpsc::UnboundedSender<HeartbeatsUpdate>,
    pub bash: mpsc::UnboundedSender<BashActivityUpdate>,
    pub commands: mpsc::UnboundedSender<CommandCatalogUpdate>,
}

impl SessionUi {
    /// Subscribe this client to the live agent roster (TS
    /// `subscribeAgentRoster`): the snapshot seeds the subagent summary
    /// counts, `roster_update` pushes keep them live. A failed
    /// subscription degrades to no counts (TS `rosterBar = undefined`).
    pub(super) async fn subscribe_roster(&mut self) {
        let snapshot = self
            .client
            .request(DaemonCommand::RosterSubscribe {
                id: None,
                rest: Map::default(),
            })
            .await;
        if let Ok(response) = snapshot {
            if response.success {
                self.roster = response
                    .data
                    .as_ref()
                    .and_then(|data| data.get("roster"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
            }
        }
    }

    /// Apply one roster push (`changed` upsert by agent id, `removed`
    /// deletes, `resync` replaces the whole roster; TS `roster-store`).
    pub(super) fn apply_roster_update(
        &mut self,
        changed: Vec<Value>,
        removed: Vec<String>,
        resync: bool,
    ) {
        if resync {
            self.roster.clear();
        }
        for entry in changed {
            let Some(agent_id) = entry.get("agentId").and_then(Value::as_str) else {
                continue;
            };
            if let Some(existing) = self
                .roster
                .iter_mut()
                .find(|row| row.get("agentId").and_then(Value::as_str) == Some(agent_id))
            {
                *existing = entry;
            } else {
                self.roster.push(entry);
            }
        }
        for agent_id in removed {
            self.roster.retain(|row| {
                row.get("agentId").and_then(Value::as_str) != Some(agent_id.as_str())
            });
        }
    }

    /// Refresh the one-line activity dock and the title's cost (the
    /// only writer of `chrome.cost_usd`) from the existing session
    /// feeds.
    pub(super) fn update_subagent_summary(&mut self, view: &mut AgentView) {
        let identity = crate::subagents::SessionIdentity::new(
            (!self.active_session_id.is_empty()).then(|| self.active_session_id.clone()),
            (!self.session_id.is_empty()).then(|| self.session_id.clone()),
            self.session_file.clone(),
        );
        self.subagent_counts = crate::subagents::count_descendants(&self.roster, &identity);
        // The title's spend is the family rollup the agents view bills
        // the session's row, refreshed on every roster push.
        view.chrome.cost_usd = crate::subagents::family_cost(&self.roster, &identity);
        let dock = self.activity_dock_state();
        // A focused selection must stay on a rendered group: only the
        // goal group can leave the row (its goal ended), and the
        // selection steps back to the group that now ends the row.
        if self.subagents_focused && !dock.groups().contains(&self.activity_group) {
            self.activity_group =
                dock.step(self.activity_group, crate::chrome::ActivityDirection::Prev);
        }
        view.chrome.activity = Some(crate::chrome::ActivityDock {
            selected: self.activity_group,
            focused: self.subagents_focused,
            ..dock
        });
        if let Some(bash_view) = view.bash_view.as_mut() {
            bash_view.apply_activities(crate::bash_view::parse_bash_activities(
                &self.bash_activities,
            ));
        }
    }

    /// The dock's feed state: the live counts, the goal row's label, and
    /// the selection/focus the caller owns. The row render, the focus
    /// hand-off, and the arrows' traversal all read this one mapping —
    /// a group renders exactly when it stays traversable.
    pub(super) fn activity_dock_state(&self) -> crate::chrome::ActivityDock {
        // The dock is the goal's one chrome surface (the operator's
        // 2026-09-24 directive moved it off the line below the prompt
        // bar): every live state renders its row — pursuing reads the
        // elapsed time ("make it 'Pursuing goal (time)'"), and the
        // paused and budget-limited states keep their persistent label
        // here too (the tray's TS cluster no longer exists to carry
        // them; terminal states carry no row). The token budget lives
        // inside the goal panel the row opens, not on the bar.
        let goal_label = tray_goal_label(&self.goal_view.goal);
        // The dock's bash indicator counts only runs actively running
        // right now (operator scoping): finished runs stay as rows inside
        // the bash view, never in the indicator. The feed is the
        // current session's kernel registry — nested subagents' kernels
        // are separate and never appear here.
        let bash_rows = crate::bash_view::parse_bash_activities(&self.bash_activities);
        let bash_running = bash_rows
            .iter()
            .filter(|activity| activity.running())
            .count();
        // The dock's subagent count is the live running count only:
        // idle and dead registry rows (passivated children the ledger
        // still seeds) never bloat the indicator — they render in the
        // scoped agents view.
        crate::chrome::ActivityDock {
            subagents_running_direct: self.subagent_counts.running_direct,
            subagents_running_nested: self.subagent_counts.running_nested,
            heartbeats: self.heartbeat_catalog.len(),
            heartbeats_paused: paused_heartbeat_count(&self.heartbeat_catalog),
            bash_running,
            goal_label,
            selected: self.activity_group,
            focused: self.subagents_focused,
        }
    }

    /// The editor's Down and Alt+A hand focus to the compact dock.
    pub(super) fn focus_subagents_summary(
        &mut self,
        source: &DockFocusSource,
        view: &mut AgentView,
    ) -> bool {
        // The tray override label blocks the hand-off (TS
        // `focusSubagentSummary`'s `getTrayOverrideLabel()` gate): the
        // armed Ctrl+C exit hint, or the streaming follow-up hint over a
        // non-empty draft — the override covers the streaming arm, so no
        // separate draft check is needed.
        if self.tray_override(view).is_some() {
            return false;
        }
        match source {
            DockFocusSource::PromptDown => {
                // TS `SubagentSummaryLine.isSelectable()`: the prompt's
                // Down is the subagents box's own affordance — subagents
                // must exist, and the grab selects that group. The dock's
                // other groups (heartbeats, shells, the goal row) never
                // take this Down; their shortcut stays
                // `app.subagents.focus`, so the prompt's arrows keep the
                // input-history recall in every session shape.
                if !(self.return_to_agents_view && self.subagent_counts.total > 0) {
                    return false;
                }
                self.activity_group = crate::chrome::ActivityGroup::Subagents;
            }
            DockFocusSource::Shortcut => {}
        }
        self.subagents_focused = true;
        self.update_subagent_summary(view);
        true
    }

    /// Open the scoped agents view from the focused summary line (TS
    /// `openScopedAgentsView` -> `returnToAgentsView("scoped_agents_view")`):
    /// the session detaches and the agents view reopens scoped to this
    /// session's subtree, anchored on it.
    pub(super) fn open_scoped_agents_view(&mut self, view: &mut AgentView) {
        self.subagents_focused = false;
        self.update_subagent_summary(view);
        // `tui subagents open`: fire-and-forget like the scroll adoption
        // event - the keypress never waits on the telemetry flush.
        if let Some(telemetry) = self.telemetry.clone() {
            let children_total = self.subagent_counts.total as u64;
            tokio::spawn(async move {
                telemetry.subagents_view_opened(children_total).await;
            });
        }
        self.scoped_agents_view = Some(crate::agents_view::AgentsViewScope {
            active_session_id: Some(self.active_session_id.clone()),
            session_id: Some(self.session_id.clone()),
            session_name: self.session_name.clone(),
        });
        self.open_agents_view = true;
        self.exit_requested = true;
        self.dirty = true;
    }

    fn emit_activity_opened(&self, kind: &'static str) {
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.activity_opened(kind).await;
            });
        }
    }

    /// The dock group a plain click opens (the dock's Enter route,
    /// operator directive 2026-09-29): the click is an explicit user
    /// choice, a direction key's peer — it moves the dock's selection
    /// to the clicked group, takes the focus, and opens the group's
    /// own view through the focused Enter's exact dispatch.
    pub(crate) fn open_dock_group_from_click(
        &mut self,
        group: crate::chrome::ActivityGroup,
        view: &mut AgentView,
    ) {
        self.activity_group = group;
        self.subagents_focused = true;
        self.update_subagent_summary(view);
        self.open_dock_group_view(view);
    }

    /// The tray's `← manage` hint click performs the hinted action
    /// (operator directive 2026-09-29): the left arrow's agents-back
    /// handoff — the pane goes to the agents view (a `--no-session`
    /// run has no daemon fleet to browse, so the click reports that
    /// exactly like the key). The dispatch gates on the empty editor
    /// exactly like `app.agents.back`, so the click never does more
    /// than the hint promises.
    pub(crate) fn open_agents_view_from_hint(&mut self, view: &mut AgentView) {
        if self.return_to_agents_view {
            self.open_agents_view = true;
            self.exit_requested = true;
        } else {
            self.note(
                "The agents view needs a daemon-hosted session; start normally (without --no-session) to browse sessions",
                view,
            );
        }
        self.dirty = true;
    }

    /// The dock's Enter hand-off (the operator's direct-navigation
    /// redesign): the focused group opens its own view directly — the
    /// scoped agents view for subagents, the heartbeats view, or the
    /// bash view — with no intermediate grouped list.
    pub(super) fn open_dock_group_view(&mut self, view: &mut AgentView) {
        match self.activity_group {
            crate::chrome::ActivityGroup::Subagents => {
                self.emit_activity_opened("subagents");
                // The same gate as before: a run that cannot open the
                // scoped agents view shows the note instead of leaving
                // the session view.
                if self.return_to_agents_view {
                    self.open_scoped_agents_view(view);
                } else {
                    self.subagents_focused = false;
                    self.note(
                        "The agents view needs a daemon-hosted session; start normally (without --no-session) to browse sessions",
                        view,
                    );
                }
            }
            crate::chrome::ActivityGroup::Heartbeats => {
                self.emit_activity_opened("heartbeats");
                self.open_heartbeats_view(view);
            }
            crate::chrome::ActivityGroup::Bash => {
                self.emit_activity_opened("bash");
                self.open_bash_view(view);
            }
            crate::chrome::ActivityGroup::Goal => {
                self.emit_activity_opened("goal");
                self.open_goal_panel(view);
            }
        }
    }

    /// The dock's goal row opens the read-only goal panel (the
    /// operator's 2026-09-24 directive: selecting the `Pursuing goal`
    /// row shows "what the goal prompt is").
    fn open_goal_panel(&mut self, view: &mut AgentView) {
        view.goal_panel = Some(GoalPanel {
            goal: self.goal_view.goal.clone(),
            // The panel renders inside this row budget: a multi-screen
            // objective clips (with a marker) instead of growing the dock
            // past the frame, which would front-crop the title away.
            viewport_rows: picker_viewport_rows(view.terminal_rows()),
        });
        self.subagents_focused = false;
        self.update_subagent_summary(view);
        self.dirty = true;
    }

    /// Open the read-only info panel over the editor dock (the
    /// operator's 2026-09-26 directive: the client info displays —
    /// `/context`, `/session`, `/system-prompt`, `/logs`, `/changelog`,
    /// `/hotkeys`, the `/traces` blocks, and `/list` — render as the
    /// docked popup panel, the `/mcp` and `/model` panel grammar,
    /// instead of flooding the transcript with rows that persist). The
    /// content is whatever the command already built; ESC closes and
    /// returns focus to the chat with the transcript untouched.
    pub(super) fn open_info_panel(
        &mut self,
        view: &mut AgentView,
        title: Option<String>,
        content: InfoContent,
    ) {
        view.info_panel = Some(crate::info_panel::InfoPanel::new(title, content));
        self.dirty = true;
    }

    /// The goal panel owns the frame while open: the close and back
    /// keys dismiss it; every other key is consumed (a read-only view).
    pub(super) fn handle_goal_panel_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The panel consumes Ctrl+C (close, not exit): report the handled
        // press so the force-quit guard can disarm once the whole pair was
        // consumed with TS semantics (the same discipline as the other
        // modal handlers).
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        if view.editor.keybindings().matches(&id, "tui.select.cancel")
            || view.editor.keybindings().matches(&id, "app.modal.back")
            || view.editor.keybindings().matches(&id, "app.clear")
        {
            view.goal_panel = None;
            // The exit restores the dock's own group (the operator's
            // 2026-09-26 panel-exit ruling): ESC/left lands back on the
            // goal row, ready to re-open, not on the prompt bar.
            self.focus_activity_dock(view);
            self.dirty = true;
        }
        Ok(())
    }

    /// The info panel owns the frame while open: the navigation keys
    /// scroll its window, the close keys dismiss it, and every other key
    /// is consumed — the read-only document never leaks a key back to
    /// the editor, and the transcript gains nothing while it is open.
    pub(super) fn handle_info_panel_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The panel consumes Ctrl+C (close, not exit): report the handled
        // press so the force-quit guard can disarm once the whole pair was
        // consumed with TS semantics (the same discipline as the other
        // modal handlers).
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        if view.info_panel.as_mut().is_some_and(|panel| {
            panel.handle_key(&id, view.editor.keybindings()) == InfoPanelAction::Close
        }) {
            view.info_panel = None;
        }
        self.dirty = true;
        Ok(())
    }

    /// The activity dock follows the scoped heartbeat catalog (TS
    /// `getTrayHeartbeatLabel` moved into the dock: the tray no longer
    /// carries a heartbeat count beside the model name).
    pub(crate) fn sync_activity_dock(&mut self, view: &mut AgentView) {
        let previous = view.chrome.activity.clone();
        self.update_subagent_summary(view);
        if previous != view.chrome.activity {
            self.dirty = true;
        }
    }
}

/// The retry-episode collapse (SANCTIONED DIVERGENCE from TS, operator
/// ruling 2026-09-23): pop the trailing failed-attempt error row the
/// retry supersedes, so the ONE line the episode shows while it runs is
/// the transient loader (updated in place) and the ONE line it leaves is
/// the durable outcome row. No-op when the trailing entry is anything
/// else (an abort row, tool-call-carrying failures, a settled reply).
pub(crate) fn pop_superseded_attempt_row(view: &mut AgentView) -> bool {
    if view
        .chat
        .last()
        .is_some_and(crate::snapshot::is_superseded_attempt_row)
    {
        view.pop_chat_entry().is_some()
    } else {
        false
    }
}

#[cfg(test)]
mod activity_dock_counts_tests {
    use super::paused_heartbeat_count;
    use crate::heartbeats_picker::{parse_heartbeat_job, HeartbeatEntry};
    use serde_json::json;

    fn entry(job_json: &serde_json::Value) -> HeartbeatEntry {
        HeartbeatEntry {
            job: parse_heartbeat_job(job_json).expect("job parses"),
            session_name: None,
            first_message: None,
        }
    }

    fn job(id: &str, status: &str) -> serde_json::Value {
        json!({
            "id": id,
            "status": status,
            "source": "heartbeat",
            "activeSessionId": "live-1",
            "sessionId": "sess-1",
            "schedule": {"kind": "interval", "expression": "every 30m"},
        })
    }

    /// The dock's paused count is the helper the dock reads (not a local
    /// recount) and stays label-independent: unlabeled agent heartbeats
    /// (the dogfood repro) count exactly like labeled ones.
    #[test]
    fn dock_counts_heartbeats_and_paused() {
        let labeled = entry(&job("labeled", "active"));
        let mut unlabeled = job("unlabeled", "active");
        unlabeled["label"] = serde_json::Value::Null;
        let unlabeled = entry(&unlabeled);
        let paused = entry(&job("b", "paused"));
        let catalog = vec![labeled, unlabeled, paused];
        assert_eq!(catalog.len(), 3);
        assert_eq!(paused_heartbeat_count(&catalog), 1);
        // An all-active catalog renders no paused suffix.
        let active = vec![entry(&job("a", "active")), entry(&job("c", "active"))];
        assert_eq!(paused_heartbeat_count(&active), 0);
    }

    /// Operator scoping: the session wrapper passes no child session ids,
    /// so a nested session's heartbeat drops while the session's own
    /// rows stay (TS `scopeHeartbeatsToSession` kept the children's jobs
    /// — the divergence lives in the caller).
    #[test]
    fn dock_heartbeats_scope_to_the_current_session_only() {
        let own = entry(&job("own", "active"));
        // The child's durable session differs: with an empty child-id
        // list it must drop even though its active id also differs.
        let mut child = job("child", "active");
        child["activeSessionId"] = json!("child-live");
        child["sessionId"] = json!("sess-child");
        let child = entry(&child);
        let scoped = crate::heartbeats_picker::scope_heartbeats(
            vec![own, child],
            Some("live-1"),
            Some("sess-1"),
            &[],
        );
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].job.id, "own");
    }

    /// Operator scoping: the dock's bash indicator counts only runs
    /// actively running right now — finished runs stay in the bash view
    /// as rows, never in the indicator.
    #[test]
    fn dock_bash_counts_only_running_runs() {
        let activities = crate::bash_view::parse_bash_activities(&json!({"activities": [
            {"id":"a","command":"sleep 1","status":"running"},
            {"id":"b","command":"echo hi","status":"finished","exitCode":0},
            {"id":"c","command":"sleep 2","status":"running"},
        ]}));
        let running = activities
            .iter()
            .filter(|activity| activity.running())
            .count();
        assert_eq!(running, 2, "finished runs never inflate the indicator");
        assert_eq!(activities.len(), 3);
    }
}

#[cfg(test)]
mod retry_collapse_tests {
    use super::pop_superseded_attempt_row;
    use crate::chat::{ChatEntry, StatusKind};
    use crate::theme::{ColorMode, Theme};
    use crate::view::AgentView;

    fn view_with(entries: Vec<ChatEntry>) -> AgentView {
        let mut view = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
        for entry in entries {
            view.push_entry(entry);
        }
        view
    }

    fn failed_attempt(text: &str) -> ChatEntry {
        ChatEntry::Assistant(Box::new(crate::chat::AssistantMessage {
            blocks: Vec::new(),
            has_tool_calls: false,
            streaming: false,
            error: Some(format!("Error: {text}")),
            aborted: false,
        }))
    }

    fn aborted_attempt() -> ChatEntry {
        ChatEntry::Assistant(Box::new(crate::chat::AssistantMessage {
            blocks: Vec::new(),
            has_tool_calls: false,
            streaming: false,
            error: Some("Operation aborted".to_string()),
            aborted: true,
        }))
    }

    /// The 429-storm single-line collapse (operator ruling 2026-09-23): the
    /// trailing failed-attempt error row pops when its retry supersedes it —
    /// and only that row (an abort, a settled reply, or a tool-carrying
    /// failure stays).
    #[test]
    fn pops_only_the_superseded_failed_attempt() {
        let mut view = view_with(vec![
            ChatEntry::User {
                text: "hi".to_string(),
            },
            failed_attempt("429 Too many concurrent requests"),
        ]);
        assert!(pop_superseded_attempt_row(&mut view));
        assert_eq!(view.chat_len(), 1, "only the user row remains");
        // A second pop finds nothing: exactly one row per attempt.
        assert!(!pop_superseded_attempt_row(&mut view));

        // An abort row never pops (aborts are not retried).
        let mut view = view_with(vec![aborted_attempt()]);
        assert!(!pop_superseded_attempt_row(&mut view));

        // A tool-carrying failure never pops (the cards carry the failure).
        let mut view = view_with(vec![ChatEntry::Assistant(Box::new(
            crate::chat::AssistantMessage {
                blocks: Vec::new(),
                has_tool_calls: true,
                streaming: false,
                error: Some("Error: mid-run failure".to_string()),
                aborted: false,
            },
        ))]);
        assert!(!pop_superseded_attempt_row(&mut view));

        // A status row (the episode outcome) never pops.
        let mut view = view_with(vec![ChatEntry::Status {
            text: "Recovered after 2 retries: provider down".to_string(),
            kind: StatusKind::Info,
        }]);
        assert!(!pop_superseded_attempt_row(&mut view));
    }
}
