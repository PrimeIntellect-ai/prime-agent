//! The activity dock and its group views, the roster-driven subagent
//! summary, the goal and info panels, and the retry-episode collapse.

use super::{
    key_event_to_id, mpsc, paused_heartbeat_count, picker_viewport_rows, tray_goal_label,
    AgentView, BashActivityUpdate, CommandCatalogUpdate, DaemonCommand, DockFocusSource,
    FactoryUpdate, GoalPanel, HeartbeatsUpdate, InfoContent, InfoPanelAction, KeyEvent, Map,
    Result, SessionUi, Value,
};

pub(crate) struct ActivityUpdates {
    pub heartbeats: mpsc::UnboundedSender<HeartbeatsUpdate>,
    pub bash: mpsc::UnboundedSender<BashActivityUpdate>,
    pub factory: mpsc::UnboundedSender<FactoryUpdate>,
    pub commands: mpsc::UnboundedSender<CommandCatalogUpdate>,
}

impl SessionUi {
    /// Subscribe this client to the live agent roster: the snapshot seeds the subagent summary
    /// counts, `roster_update` pushes keep them live. A failed subscription degrades to no counts.
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

    /// Apply one roster push: `changed` upserts by agent id, `removed` deletes,
    /// `resync` replaces the whole roster.
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

    /// Refresh the one-line activity dock and the title's cost (the only writer
    /// of `chrome.cost_usd`).
    pub(super) fn update_subagent_summary(&mut self, view: &mut AgentView) {
        let identity = crate::subagents::SessionIdentity::new(
            (!self.active_session_id.is_empty()).then(|| self.active_session_id.clone()),
            (!self.session_id.is_empty()).then(|| self.session_id.clone()),
            self.session_file.clone(),
        );
        self.subagent_counts = crate::subagents::count_descendants(&self.roster, &identity);
        // The title's spend is the family rollup the agents view bills the
        // session's row.
        view.chrome.cost_usd = crate::subagents::family_cost(&self.roster, &identity);
        let dock = self.activity_dock_state();
        // A focused selection must stay on a rendered group: only the goal group can leave the row
        // (its goal ended), and the selection steps back to the group that now ends the row.
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

    /// The dock's feed state: the live counts, the goal row's label, and the selection/focus the
    /// caller owns. A group renders exactly when it stays traversable.
    pub(super) fn activity_dock_state(&self) -> crate::chrome::ActivityDock {
        // The dock is the goal's one chrome surface (the operator's 2026-09-24 directive): every
        // live state renders its row — pursuing reads the elapsed time, the paused and
        // budget-limited states keep their label here.
        let goal_label = tray_goal_label(&self.goal_view.goal);
        // The dock's bash indicator counts only runs actively running right now (operator scoping):
        // finished runs stay in the bash view.
        let bash_rows = crate::bash_view::parse_bash_activities(&self.bash_activities);
        let bash_running = bash_rows
            .iter()
            .filter(|activity| activity.running())
            .count();
        // The dock's factory indicator counts live runs only — the
        // view's one liveness rule (`FactoryRunSnapshot::is_live`: a
        // live state, or children still in flight — a `done` run whose
        // resident children still run keeps its count like its panel
        // and its stop control). Fully terminal runs stay as panels
        // inside the factory page, never in the indicator — the bash
        // group's running-only scoping, one lane over.
        let factory_runs = crate::factory_view::parse_factory_runs(&self.factory_graph)
            .iter()
            .filter(|run| run.is_live())
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
            factory_runs,
            // The group renders exactly while the daemon advertises the
            // lane: the factory's opt-in gate (a daemon without the
            // factory lane never mounts the group).
            factory_group: self.factory_activity_supported(),
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
        // The tray override label blocks the hand-off (the exit hint or the
        // streaming follow-up hint over a non-empty draft).
        if self.tray_override(view).is_some() {
            return false;
        }
        match source {
            DockFocusSource::PromptDown => {
                // The prompt's Down always enters the dock, whatever its
                // counts (the operator's 2026-10-01 consistency ruling: an
                // all-zero dock, or one with only shells running, must stay
                // reachable — TS `SubagentSummaryLine.isSelectable()` gated
                // this on existing subagents, a sanctioned divergence). The
                // grab lands on the row's first group; Left/Right walk the
                // rest.
                self.activity_group = crate::chrome::ActivityGroup::Subagents;
            }
            DockFocusSource::Shortcut => {}
        }
        self.subagents_focused = true;
        self.update_subagent_summary(view);
        true
    }

    /// Open the scoped agents view from the focused summary line: the session
    /// detaches and the agents view reopens scoped to this session's subtree.
    pub(super) fn open_scoped_agents_view(&mut self, view: &mut AgentView) {
        self.subagents_focused = false;
        self.update_subagent_summary(view);
        // `tui subagents open`: fire-and-forget.
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

    /// The dock group a plain click opens (operator directive 2026-09-29): a click moves the dock's
    /// selection to the clicked group, takes the focus, and opens the group's own view.
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

    /// The tray's `← manage` hint click performs the hinted action (operator directive 2026-09-29):
    /// the left arrow's agents-back handoff, gated the same way as `app.agents.back` (a
    /// `--no-session` run reports that like the key).
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

    /// The dock's Enter hand-off (the operator's direct-navigation redesign):
    /// the focused group opens its own view directly, no intermediate list.
    pub(super) fn open_dock_group_view(&mut self, view: &mut AgentView) {
        match self.activity_group {
            crate::chrome::ActivityGroup::Subagents => {
                self.emit_activity_opened("subagents");
                // A run that cannot open the scoped agents view shows the note instead of
                // leaving the session view.
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
            crate::chrome::ActivityGroup::Factory => {
                self.emit_activity_opened("factory");
                self.open_factory_page(view);
            }
            crate::chrome::ActivityGroup::Goal => {
                self.emit_activity_opened("goal");
                self.open_goal_panel(view);
            }
        }
    }

    /// The dock's goal row opens the read-only goal panel (the operator's
    /// 2026-09-24 directive).
    fn open_goal_panel(&mut self, view: &mut AgentView) {
        view.goal_panel = Some(GoalPanel {
            goal: self.goal_view.goal.clone(),
            // The panel renders inside this row budget: a multi-screen objective clips (with a
            // marker) instead of growing the dock past the frame, which would front-crop the title
            // away.
            viewport_rows: picker_viewport_rows(view.terminal_rows()),
        });
        self.subagents_focused = false;
        self.update_subagent_summary(view);
        self.dirty = true;
    }

    /// Open the read-only info panel over the editor dock (the operator's 2026-09-26 directive: the
    /// client info displays render as the docked popup panel instead of flooding the transcript).
    /// ESC closes with the transcript untouched.
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
        // The panel consumes Ctrl+C (close, not exit); report it so the force-quit
        // guard can disarm.
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        if view.editor.keybindings().matches(&id, "tui.select.cancel")
            || view.editor.keybindings().matches(&id, "app.modal.back")
            || view.editor.keybindings().matches(&id, "app.clear")
        {
            view.goal_panel = None;
            // The exit restores the dock's own group (the operator's 2026-09-26
            // panel-exit ruling).
            self.focus_activity_dock(view);
            self.dirty = true;
        }
        Ok(())
    }

    /// The info panel owns the frame while open: the navigation keys scroll its
    /// window, the close keys dismiss it, every other key is consumed.
    pub(super) fn handle_info_panel_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The panel consumes Ctrl+C (close, not exit); report it so the force-quit
        // guard can disarm.
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

    /// The activity dock follows the scoped heartbeat catalog (the tray no
    /// longer carries a heartbeat count beside the model name).
    pub(crate) fn sync_activity_dock(&mut self, view: &mut AgentView) {
        let previous = view.chrome.activity.clone();
        self.update_subagent_summary(view);
        if previous != view.chrome.activity {
            self.dirty = true;
        }
    }
}

/// The retry-episode collapse (SANCTIONED DIVERGENCE from TS, operator ruling 2026-09-23): pop the
/// trailing failed-attempt error row the retry supersedes, leaving the transient loader while the
/// episode runs and the durable outcome row at the settle. No-op on anything else.
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
        let active = vec![entry(&job("a", "active")), entry(&job("c", "active"))];
        assert_eq!(paused_heartbeat_count(&active), 0);
    }

    /// Operator scoping divergence (TS `scopeHeartbeatsToSession` kept the
    /// children's jobs — the divergence lives in the caller).
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
