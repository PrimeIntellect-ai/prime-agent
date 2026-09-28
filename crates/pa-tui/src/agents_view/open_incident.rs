//! The open flow (the entry anchor, the subagent list toggle, the
//! row-open funnel with its finish bookkeeping and the scope back/
//! root navigation) and the incident-notice surface (the structured-
//! log poll, the dismissal, and the panel render - moved with their
//! concern).
use super::*;

impl AgentsViewMode {
    pub(super) fn open_selected(&mut self) {
        if self.anchor_selection_pending && self.options.scope.is_none() {
            self.status = Some(ANCHOR_LOADING_HINT.to_string());
            return;
        }
        let Some(row) = self.rows.get(self.selected).cloned() else {
            return;
        };
        match row.kind {
            RowKind::SubagentSummary => self.toggle_subagent_list(&row),
            RowKind::Subagent => self.open_subagent_row(&row),
            RowKind::Agent => self.open_row(&row, Vec::new()),
        }
    }

    /// Toggle the selected parent's subagent list (TS `toggleSubagentList`,
    /// plus the operator's two-line split): alt+right and open both land
    /// here; the target is the selected row's parent for a summary line,
    /// the row itself otherwise. A summary line toggles its own line
    /// (the running line's identity prefix dispatches the running set,
    /// the inactive line's the inactive set); an agent row toggles its
    /// first line — the running one while work runs, else the inactive
    /// one.
    pub(super) fn toggle_subagent_list(&mut self, row: &AgentsViewRow) {
        let target = match row.kind {
            RowKind::SubagentSummary => row.parent_identity.clone(),
            _ => Some(row.identity.clone()),
        };
        let Some(target) = target else {
            return;
        };
        let inactive_line = match row.kind {
            RowKind::SubagentSummary => row
                .identity
                .starts_with(crate::agents_view_forest::INACTIVE_SUMMARY_ROW_PREFIX),
            _ => row.running_subagent_count == 0,
        };
        let expanded = if inactive_line {
            &mut self.expanded_inactive_parents
        } else {
            &mut self.expanded_parents
        };
        if expanded.remove(&target) {
            // Collapsing also hides the spawn program (TS clears
            // `programShownParents` with the expansion); the program
            // surface is not part of this lane.
        } else {
            expanded.insert(target);
        }
        self.rebuild_rows();
    }

    /// Drill into a nested child row (TS `openSelectedSubagent`): the open
    /// result carries the child's ancestor chain, so the tree re-expands to
    /// the row when the chat returns to the view.
    pub(super) fn open_subagent_row(&mut self, row: &AgentsViewRow) {
        let ancestors = ancestor_session_ids(&self.rows, row.parent_identity.as_deref());
        if row.summary.get("activeSessionId").is_some() || row.summary.get("sessionFile").is_some()
        {
            self.open_row(row, ancestors);
            return;
        }
        // The whole subagent tree belongs to its root agent's session, so a
        // child without its own runtime resolves to its top-level ancestor
        // (TS `createUnattachableChildOpenResult`): open the parent, keep
        // the child row selected, and surface why.
        let root = self.find_subagent_root_row(row);
        let Some(root) = root else {
            self.status = Some(
                "Cannot open agent without an active runtime or saved session file".to_string(),
            );
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

    /// The top-level ancestor row of a nested row (TS `findSubagentRootRow`).
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

    /// Open a session row: attach a live session, or reopen the saved
    /// file (TS `finish({ type: "open" })`), carrying the row's identity,
    /// key, and depth metadata for the flow.
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
        self.status =
            Some("Cannot open agent without an active runtime or saved session file".to_string());
    }

    /// Record the open outcome (TS the run result the loop consumes): the
    /// selection plus the row metadata the flow and the session carry.
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

    /// Hand the terminal back to the scope root's session (TS
    /// `finish({ type: "scope_back" })` when `pop`: the scoped view
    /// detaches and the flow pops the scope frame — the return chat it
    /// opened from reopens, and a later agents-back lands in the parent
    /// scope. Escape reopens the same session without popping the frame.
    pub(super) fn open_scope_root(&mut self, pop: bool) {
        let Some(scope) = self.options.scope.clone() else {
            return;
        };
        let Some(active) = scope.active_session_id.clone().filter(|id| !id.is_empty()) else {
            // No runtime to return to: the flow reopens the view (TS
            // scope_back without a return chat continues the loop).
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

    /// TS `refreshIncidentNotices`: one best-effort poll of the structured
    /// agent log (a missing or unreadable log simply retries a bounded
    /// tail on the next poll and never breaks the view). `true` when the
    /// collapsed notice line changed, so the caller re-renders.
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

    /// Dismiss the collapsed incident notice (TS `dismissIncidentNotice`):
    /// `false` when none is showing; the dismissal status line confirms it.
    pub(super) fn dismiss_incident_notice(&mut self) -> bool {
        if !crate::incident_notices::dismiss_incident_notice_state(&mut self.incident_notice_state)
        {
            return false;
        }
        self.status = Some("Incident notice dismissed".to_string());
        true
    }

    /// The incident notice lines for the header (TS `renderIncidentNotice`):
    /// the styled warning line wrapped over the pane width, each wrapped row
    /// prefixed with the one-column gutter like the startup notices.
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
        // Wrap instead of truncating, so the pointer to the incident CLI
        // stays readable; `Math.max(1, width - 1)`.
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
