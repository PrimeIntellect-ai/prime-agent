//! The open flow (the entry anchor, the subagent list toggle, the row-open funnel with its
//! finish bookkeeping and the scope back/root navigation) and the incident-notice surface (the
//! structured-log poll, the dismissal, and the panel render).
use super::{
    ancestor_session_ids, has_session_children, scope_ancestors, AgentsViewMode, AgentsViewRow,
    Line, OpenedRow, PathBuf, RowKind, SessionSelection, Value, ANCHOR_LOADING_HINT,
};

impl AgentsViewMode {
    pub(super) fn open_selected(&mut self) {
        if self.anchor_selection_pending && self.options.scope.is_none() {
            self.set_status(ANCHOR_LOADING_HINT);
            return;
        }
        let Some(row) = self.rows.get(self.selected).cloned() else {
            return;
        };
        match row.kind {
            RowKind::SubagentSummary => self.toggle_subagent_list(&row),
            RowKind::Subagent => self.open_subagent_row(&row),
            RowKind::Agent => self.open_row(&row, Vec::new()),
            // A program row is read-only context: the open action never fires on it.
            RowKind::Code => {}
        }
    }

    /// The selected row's program target summary line: the agent row itself for a top-level
    /// selection, its parent for a summary line or a nested child.
    pub(super) fn program_target(&self) -> Option<&AgentsViewRow> {
        let row = self.rows.get(self.selected)?;
        let target = match row.kind {
            RowKind::Agent => row.identity.as_str(),
            RowKind::SubagentSummary | RowKind::Subagent => row.parent_identity.as_deref()?,
            // Unreachable (code rows are not selectable), exhaustive by
            // the match rule.
            RowKind::Code => return None,
        };
        self.rows.iter().find(|row| {
            row.kind == RowKind::SubagentSummary && row.parent_identity.as_deref() == Some(target)
        })
    }

    /// Show or hide the spawn program of the selected row's target. The list expands with it,
    /// and a target with no recorded program reports instead of toggling.
    pub(super) fn cycle_program_for_selected(&mut self) {
        // No target summary line, or a line whose children carry no code, is the same report.
        let target = match self.program_target() {
            Some(summary) if summary.has_spawn_code => summary.parent_identity.clone(),
            _ => None,
        };
        let Some(target) = target else {
            self.set_status("No program recorded for these subagents");
            return;
        };
        // The program only renders inside the expanded list, so reveal the expansion too,
        // toggle the program, and re-sync the selection (the rebuild can re-order rows).
        self.expanded_parents.insert(target.clone());
        if !self.program_shown_parents.remove(&target) {
            self.program_shown_parents.insert(target);
            self.actions.push("program_shown");
        }
        // The selection re-resolves onto its row through the rebuild (the rebuild re-syncs it).
        self.rebuild_rows();
    }

    /// Toggle the selected parent's subagent list (the operator's 2026-09-28 one-line merge):
    /// alt+right and open both land here; the target is the parent for a summary line, the row
    /// itself otherwise.
    pub(super) fn toggle_subagent_list(&mut self, row: &AgentsViewRow) {
        let target = match row.kind {
            RowKind::SubagentSummary => row.parent_identity.clone(),
            _ => Some(row.identity.clone()),
        };
        let Some(target) = target else {
            return;
        };
        if self.expanded_parents.remove(&target) {
            // Collapsing also hides the spawn program: the program only renders inside the
            // open list.
            self.program_shown_parents.remove(&target);
        } else {
            self.expanded_parents.insert(target);
        }
        self.rebuild_rows();
    }

    /// Drill into a nested child row: the open result carries the child's ancestor chain, so
    /// the tree re-expands to the row when the chat returns to the view.
    pub(super) fn open_subagent_row(&mut self, row: &AgentsViewRow) {
        let ancestors = ancestor_session_ids(&self.rows, row.parent_identity.as_deref());
        if row.summary.get("activeSessionId").is_some() || row.summary.get("sessionFile").is_some()
        {
            self.open_row(row, ancestors);
            return;
        }
        // A child without its own runtime resolves to its top-level ancestor: open the parent,
        // keep the child row selected, and surface why.
        let root = self.find_subagent_root_row(row);
        let Some(root) = root else {
            self.set_status("Cannot open agent without an active runtime or saved session file");
            return;
        };
        let root = root.clone();
        self.status = None;
        self.open_row_with(
            &root,
            ancestors,
            Some("Child session is unavailable; opened its parent instead".to_string()),
            Some(row.identity.clone()),
        );
    }

    /// The top-level ancestor row of a nested row.
    pub(super) fn find_subagent_root_row(&self, row: &AgentsViewRow) -> Option<&AgentsViewRow> {
        let mut identity = row.parent_identity.as_deref();
        let mut guard = 0;
        while let Some(current) = identity {
            guard += 1;
            if guard > self.rows.len() {
                return None;
            }
            let parent = self
                .rows
                .iter()
                .find(|candidate| candidate.identity == current)?;
            match parent.kind {
                RowKind::Agent => return Some(parent),
                _ => identity = parent.parent_identity.as_deref(),
            }
        }
        None
    }

    /// Open a session row: attach a live session, or reopen the saved file, carrying the
    /// row's identity, key, and depth metadata for the flow.
    pub(super) fn open_row(&mut self, row: &AgentsViewRow, ancestors: Vec<String>) {
        self.open_row_with(row, ancestors, None, None);
    }

    /// The open action shared by the drill-in paths.
    pub(super) fn open_row_with(
        &mut self,
        row: &AgentsViewRow,
        ancestors: Vec<String>,
        status_message: Option<String>,
        selected_identity: Option<String>,
    ) {
        // Attaching across the mesh is not available (TS #2516): the row
        // is visible context, and the action names the machine to use.
        if row
            .summary
            .get("remoteHost")
            .and_then(Value::as_str)
            .is_some_and(|host| !host.is_empty())
        {
            self.set_status(&format!(
                "Remote agent runs on {}; attaching across the mesh is not available",
                row.summary
                    .get("remoteHost")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            ));
            return;
        }
        let summary = &row.summary;
        if let Some(active) = summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            self.finish_open(
                SessionSelection::Attach(active.to_string()),
                row,
                ancestors,
                status_message,
                selected_identity,
            );
            return;
        }
        if let Some(file) = summary
            .get("sessionFile")
            .and_then(Value::as_str)
            .filter(|file| !file.is_empty())
        {
            self.finish_open(
                SessionSelection::Resume(PathBuf::from(file)),
                row,
                ancestors,
                status_message,
                selected_identity,
            );
            return;
        }
        self.set_status("Cannot open agent without an active runtime or saved session file");
    }

    /// Record the open outcome: the selection plus the row metadata the flow and the session
    /// carry.
    pub(super) fn finish_open(
        &mut self,
        selection: SessionSelection,
        row: &AgentsViewRow,
        ancestors: Vec<String>,
        status_message: Option<String>,
        selected_identity: Option<String>,
    ) {
        let key = crate::agents_view_forest::selection_key(&row.summary);
        let has_children = has_session_children(&self.records(), &key);
        self.opened = Some(OpenedRow {
            selection,
            expanded_ancestors: ancestors,
            selected_row_identity: selected_identity.unwrap_or_else(|| row.identity.clone()),
            selected_key: key,
            rlm_depth: row
                .summary
                .get("rlmDepth")
                .and_then(Value::as_u64)
                .map(|depth| depth as u32),
            has_children,
            status_message,
            cwd: row
                .summary
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|cwd| !cwd.is_empty())
                .map(str::to_string),
        });
        self.running = false;
    }

    /// Hand the terminal back to the scope root's session. With `pop`, the flow pops the scope
    /// frame; Escape reopens the same session without popping it.
    pub(super) fn open_scope_root(&mut self, pop: bool) {
        let Some(scope) = self.options.scope.clone() else {
            return;
        };
        let Some(active) = scope.active_session_id.clone().filter(|id| !id.is_empty()) else {
            // No runtime to return to: the flow reopens the view.
            self.scope_popped = pop;
            self.running = false;
            return;
        };
        self.scope_popped = pop;
        self.scope_back = true;
        let summary = self
            .records()
            .iter()
            .map(crate::agents_view_state::summary_for_record)
            .find(|summary| {
                summary.get("activeSessionId").and_then(Value::as_str) == Some(active.as_str())
            })
            .unwrap_or_default();
        let key = crate::agents_view_forest::selection_key(&summary);
        let has_children = has_session_children(&self.records(), &key);
        self.opened = Some(OpenedRow {
            selection: SessionSelection::Attach(active),
            expanded_ancestors: scope_ancestors(&self.records(), &scope),
            selected_row_identity: self.selected_identity.clone().unwrap_or_default(),
            selected_key: self.selected_key.clone().unwrap_or_default(),
            rlm_depth: summary
                .get("rlmDepth")
                .and_then(Value::as_u64)
                .map(|depth| depth as u32),
            has_children,
            status_message: None,
            cwd: summary
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|cwd| !cwd.is_empty())
                .map(str::to_string),
        });
        self.running = false;
    }

    /// One best-effort poll of the structured agent log (a missing or unreadable log simply
    /// retries the bounded tail). `true` when the collapsed notice line changed.
    pub(super) fn refresh_incident_notices(&mut self) -> bool {
        let Some(agent_dir) = pa_types::platform::agent_dir() else {
            return false;
        };
        let log_path = agent_dir.join("logs").join("agent.jsonl");
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as i64);
        crate::incident_notices::refresh_incident_notice_state(
            &mut self.incident_notice_state,
            &log_path,
            now_ms,
        )
    }

    /// Dismiss the collapsed incident notice: `false` when none is showing; the dismissal
    /// status line confirms it.
    pub(super) fn dismiss_incident_notice(&mut self) -> bool {
        if !crate::incident_notices::dismiss_incident_notice_state(&mut self.incident_notice_state)
        {
            return false;
        }
        self.set_status("Incident notice dismissed");
        true
    }

    /// The incident notice lines for the header: the styled warning line wrapped over the pane
    /// width, each wrapped row prefixed with the one-column gutter like the startup notices.
    pub(super) fn render_incident_notice(&self, width: usize) -> Vec<Line> {
        let Some(notice) = self.incident_notice_state.notice.as_ref() else {
            return Vec::new();
        };
        let styled = self.theme.fg(
            crate::theme::ThemeColor::Warning,
            format!(
                "⚠ {} {}",
                notice.text,
                crate::incident_notices::INCIDENT_NOTICE_POINTER
            ),
        );
        // Wrap instead of truncating, so the pointer to the incident CLI stays readable.
        let wrap_width = width.saturating_sub(1).max(1);
        crate::width::wrap_line(&vec![styled], wrap_width)
            .into_iter()
            .map(|mut line| {
                line.insert(0, crate::Span::raw(" "));
                line
            })
            .collect()
    }
}
