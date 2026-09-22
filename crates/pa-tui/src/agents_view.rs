//! The agents view: the unified live-roster + saved-catalog session list
//! (TS `AgentsViewMode`). Rows group into Running/Idle/Inactive sections,
//! the inline prompt doubles as search, and the first actions are open
//! (attach a live session) and resume (reopen a saved file); `n` starts a
//! new session. Roster pushes arrive live over `roster_subscribe`; the
//! saved catalog loads once on open (TS parity: it feeds the Inactive
//! section). The reply composer, rename, delete, and kill-subagent actions
//! wait on the Stage-3 reply machinery.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use pa_types::daemon::DaemonCommand;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::agents_view_forest::{
    ancestor_session_ids, build_rows, compute_rollups, has_session_children, resolve_selection,
    scope_ancestors, scope_depth, scope_to_subtree, AgentsViewRow, RowKind, SelectionKey,
};
use crate::agents_view_state::truncate_text;
use crate::agents_view_state::{
    build_layout, filter_empty_sessions, filter_unified_sessions, parse_search_query,
    reconcile_unified_sessions, section_title, RowLayout, Section,
};

/// The scope a scoped view opened on (TS `AgentsViewScopeKey` plus the
/// display name): the view lists this session's descendants and the back
/// key returns to it.
pub use crate::agents_view_forest::AgentsViewScope;
pub use crate::agents_view_forest::SelectionKey as AgentsViewSelectionKey;
use crate::daemon_client::{DaemonClient, DaemonClientEvent};
use crate::interactive::SessionSelection;
use crate::theme::{Theme, ThemeBg, ThemeColor};
use crate::width::{pad_line, str_width};
use crate::Line;

/// Options for one agents-view run.
#[derive(Debug, Clone)]
pub struct AgentsViewOptions {
    pub socket_path: PathBuf,
    pub cwd: PathBuf,
    pub session_dir: Option<PathBuf>,
    pub theme: String,
    pub version: String,
    /// The session the view was opened from: keeps its recency slot,
    /// survives the empty-catalog filter, and anchors a fresh open's entry
    /// selection on its row (the agents-back handoff selects the session
    /// just left, not the first row).
    pub anchor_session_id: Option<String>,
    /// Open scoped to one session's subtree (the subagent summary line's
    /// open action; TS `scoped_agents_view`): the root lists its
    /// descendants, and the back key reopens this session.
    pub scope: Option<AgentsViewScope>,
    /// The query restored from the previous view run (TS
    /// `AgentsViewPersistentState.query`: returning from an opened chat
    /// keeps the filter typed before opening it).
    pub query: Option<String>,
    /// Session ids to re-expand on open, root-most first (TS
    /// `pendingExpandedAncestorSessionIds`: returning from a drilled-in
    /// child re-opens the tree down to the row the user left).
    pub expanded_ancestors: Vec<String>,
    /// The row identity to restore the selection on (TS
    /// `persistentState.selectedRowIdentity`).
    pub selected_row_identity: Option<String>,
    /// The selection key that survives an identity flip (TS
    /// `persistentState.selectedSessionKey`).
    pub selected_key: Option<SelectionKey>,
    /// A status message the previous run left for this one (TS
    /// `persistentState.statusMessage`): the unattachable-child fallback.
    pub status_message: Option<String>,
    /// The effective keybindings (user `keybindings.json` over the TS
    /// defaults): every action and hint dispatches through this (TS
    /// `AgentsViewMode` creates its own `KeybindingsManager`), the same
    /// contract as the session view.
    pub keybindings: crate::keybindings::KeybindingsManager,
}

/// The open action the run ended with (TS `AgentsViewRunResult`'s
/// `open`/`scope_back` arms, unified): the session the flow opens plus
/// the row metadata it carries across the view/session loop.
#[derive(Debug, Clone)]
pub struct OpenedRow {
    pub selection: SessionSelection,
    pub expanded_ancestors: Vec<String>,
    pub selected_row_identity: String,
    pub selected_key: SelectionKey,
    pub rlm_depth: Option<u32>,
    pub has_children: bool,
    pub status_message: Option<String>,
}

/// How the view is driven.
pub enum AgentsViewUiMode {
    Terminal,
    /// Headless plan: typed input plus settle barriers, with rendered
    /// frames captured for the parity verifier.
    Headless(AgentsHeadlessPlan),
}

#[derive(Debug, Clone)]
pub struct AgentsHeadlessPlan {
    pub steps: Vec<AgentsStep>,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone)]
pub enum AgentsStep {
    /// Type into the search box, character by character.
    Type(String),
    /// One raw key id (e.g. "down", "enter", "ctrl+c").
    Key(String),
    /// Hold until the roster settles (or the deadline passes).
    WaitSettle { timeout_ms: u64 },
}

/// The result of one agents-view run.
#[derive(Debug, Default)]
pub struct AgentsViewOutcome {
    /// The session the user opened; `None` when the flow exits here.
    pub selection: Option<SessionSelection>,
    pub frames: Vec<String>,
    /// The query typed in this run, for the caller to restore on re-entry
    /// (TS `AgentsViewPersistentState.query`).
    pub query: Option<String>,
    /// The view exited through its parent key while scoped (TS
    /// `scope_back`): the flow pops the scope frame, so a later agents-back
    /// lands in the parent scope, not this one.
    pub scope_popped: bool,
    /// The scope root left the roster mid-run (TS
    /// `resolveAgentsViewScopeFrames` dropping a frame): the flow drops the
    /// scope frame.
    pub scope_dropped: bool,
    /// Session ids of the opened row's ancestors, root-most first (TS
    /// `expandedAncestorSessionIds`): the flow feeds the next view run so
    /// the tree re-expands to the drilled row.
    pub expanded_ancestors: Vec<String>,
    /// The opened (or scope-back) row's identity and key, for the next
    /// run's selection restore (TS `persistentState.selectedRowIdentity` /
    /// `selectedSessionKey`).
    pub selected_row_identity: Option<String>,
    pub selected_key: Option<SelectionKey>,
    /// The opened session's `rlmDepth` (TS `sessionDepth`): a drilled-in
    /// child renders its `depth N` tray label.
    pub opened_rlm_depth: Option<u32>,
    /// Whether the opened session has direct children (TS
    /// `sessionHasChildren`).
    pub opened_has_children: bool,
    /// A status message the session opener left (TS
    /// `statusMessage` on the open result): the unattachable-child
    /// fallback surfaces it in the next view run.
    pub status_message: Option<String>,
}

/// TS `WORKING_ICON_INTERVAL_MS`: the running-row icon frame cadence.
const PULSE_INTERVAL_MS: u64 = 250;

enum UiInput {
    Key(String),
    Settled,
    Done,
    /// The saved-catalog fetch landed (TS `armSavedSearchFetch` applying
    /// its result while the view already runs): the Inactive section
    /// rebuilds from these rows.
    SavedLoaded {
        sessions: Vec<Value>,
    },
    /// The saved-catalog fetch failed; the status line reports it.
    SavedFailed {
        error: String,
    },
}

/// The flow's roster connection (TS `AgentsViewPersistentState.rosterClient`):
/// the agents-view loop keeps one daemon connection alive across its view
/// runs, so a handoff back from a chat reuses the live connection instead
/// of reconnecting (the hello handshake and auth never run twice for the
/// same flow). The connection stays unattached to any session; roster
/// subscriptions come and go with the individual view runs.
pub struct AgentsViewLink {
    client: DaemonClient,
    events: mpsc::UnboundedReceiver<DaemonClientEvent>,
}

impl AgentsViewLink {
    async fn connect(socket_path: &std::path::Path) -> Result<Self> {
        let (client, events) = DaemonClient::connect(socket_path).await?;
        Ok(Self { client, events })
    }

    /// Release the connection; the supervisor drops the roster subscription
    /// with the socket (TS `runAgentsViewMode` closes the persistent client
    /// when its loop ends).
    pub fn close(&self) {
        self.client.close();
    }
}

/// One agents-view run plus the roster connection it kept alive for the
/// next run in the same flow (`None` when the run exited fully and closed
/// it).
pub struct AgentsViewRun {
    pub outcome: AgentsViewOutcome,
    pub link: Option<AgentsViewLink>,
}

/// The agents view state: roster + catalog data, search, selection, and
/// the pending exit/open requests.
struct AgentsViewMode {
    options: AgentsViewOptions,
    theme: Theme,
    roster: Vec<Value>,
    saved: Vec<Value>,
    rows: Vec<AgentsViewRow>,
    selected: usize,
    query: String,
    status: Option<String>,
    /// The scope root's `depth` metadata (`rlmDepth + 1`); `None` when the
    /// scope root is not on the roster (the view falls back to the global
    /// list with a status message, TS scope-resolution fallback).
    scope_depth: Option<u32>,
    /// The scope root resolved on the last rebuild.
    scope_active: bool,
    /// Whether the scope root left the roster mid-run (TS
    /// `resolveAgentsViewScopeFrames` dropping the frame): reported on the
    /// outcome so the flow drops the scope.
    scope_dropped: bool,
    /// Parent row identities whose subagent lists are expanded (TS
    /// `expandedSubagentParents`).
    expanded_parents: std::collections::HashSet<String>,
    /// Session ids to expand on the next rebuild (TS
    /// `pendingExpandedAncestorSessionIds`, consumed once).
    pending_ancestors: Option<Vec<String>>,
    /// The row identity the selection restores on (TS
    /// `persistentState.selectedRowIdentity`).
    selected_identity: Option<String>,
    /// The selection key that survives an identity flip (TS
    /// `persistentState.selectedSessionKey`).
    selected_key: Option<SelectionKey>,
    /// Whether the entry selection still waits on the anchor session's row:
    /// a fresh open (the agents-back handoff opens the view on the session
    /// just left) lands the selection there once the row appears — a nested
    /// anchor arrives with its ancestors' lists expanded — and the first
    /// user move cancels the wait. A scoped view never lists the anchor
    /// (the scope root is excluded), so the first-row default stands there.
    anchor_selection_pending: bool,
    /// First ctrl+c shows the exit hint; the second exits.
    exit_armed: bool,
    /// The double-Ctrl+C force-quit guard (the run's shared instance is
    /// installed by `run_agents_view` after `new`).
    exit_guard: crate::exit_guard::ExitGuard,
    pulse: usize,
    running: bool,
    /// The view exited through its parent key (TS `scope_back`): the flow
    /// pops the scope frame.
    scope_popped: bool,
    /// The open action the run ended with (`None` while the view runs).
    opened: Option<OpenedRow>,
    /// ctrl+n requested a fresh session (TS `app.agents.new`).
    new_session: bool,
    /// The effective keybindings (TS `AgentsViewMode.keybindings`): every
    /// action and hint dispatches through this manager.
    keybindings: crate::keybindings::KeybindingsManager,
    /// The terminal height of the last rendered frame (TS reads
    /// `ui.terminal.rows` live at key time); 0 before the first render,
    /// where `page_step` floors to the 4-row minimum anyway.
    last_height: usize,
}

impl AgentsViewMode {
    fn new(options: AgentsViewOptions) -> Self {
        let theme = crate::app::load_theme(&options.theme);
        let query = options.query.clone().unwrap_or_default();
        let status = options.status_message.clone();
        let pending_ancestors =
            (!options.expanded_ancestors.is_empty()).then(|| options.expanded_ancestors.clone());
        let selected_identity = options.selected_row_identity.clone();
        let selected_key = options.selected_key.clone();
        let keybindings = options.keybindings.clone();
        // A fresh open (no carried identity or usable key — the scope-back
        // handoff leaks an empty identity and a key with no session ids,
        // neither restores anything) waits on the anchor: the session the
        // view was opened from, the agents-back handoff's anchor.
        let carried_selection = options
            .selected_row_identity
            .as_deref()
            .is_some_and(|identity| !identity.is_empty())
            || options
                .selected_key
                .as_ref()
                .is_some_and(|key| key.session_id.is_some() || key.active_session_id.is_some());
        let anchor_selection_pending = !carried_selection
            && options
                .anchor_session_id
                .as_deref()
                .is_some_and(|anchor| !anchor.is_empty());
        AgentsViewMode {
            options,
            theme,
            keybindings,
            last_height: 0,
            roster: Vec::new(),
            saved: Vec::new(),
            rows: Vec::new(),
            selected: 0,
            query,
            status,
            scope_depth: None,
            scope_active: false,
            scope_dropped: false,
            expanded_parents: Default::default(),
            pending_ancestors,
            selected_identity,
            selected_key,
            anchor_selection_pending,
            exit_armed: false,
            exit_guard: crate::exit_guard::ExitGuard::new(),
            pulse: 0,
            running: true,
            scope_popped: false,
            opened: None,
            new_session: false,
        }
    }

    /// The unified records the view runs on (reconciled from the live
    /// roster and the saved catalog).
    fn records(&self) -> Vec<crate::agents_view_state::UnifiedRecord> {
        reconcile_unified_sessions(&self.roster, &self.saved)
    }

    /// Rebuild rows from the current roster, catalog, and query (TS
    /// `reconcileCatalogs` + `getFilteredRecords`). A scoped run lists the
    /// scope root's subtree with the root's own row excluded (its direct
    /// children list as top-level rows); a scope root that left the roster
    /// falls back to the global list with a status message and reports the
    /// drop so the flow discards the scope.
    fn rebuild_rows(&mut self) {
        let identity = self.rows.get(self.selected).map(|row| row.identity.clone());
        let records = self.records();
        // Scope resolution (TS `resolveAgentsViewScopeFrames`): a frame
        // whose root is gone drops, with the nearest fallback surfaced as a
        // status message.
        let mut scope_active = false;
        let scoped = match &self.options.scope {
            Some(scope) if !self.scope_dropped => match scope_to_subtree(&records, scope) {
                Some(scoped) => {
                    scope_active = true;
                    self.scope_depth = scope_depth(&records, scope);
                    Some(scoped)
                }
                None => {
                    self.scope_depth = None;
                    self.scope_dropped = true;
                    self.status = Some(
                        "Scope is no longer available; returned to the global view".to_string(),
                    );
                    None
                }
            },
            _ => None,
        };
        self.scope_active = scope_active;
        let working: &[_] = match &scoped {
            Some(scoped) => scoped,
            None => &records,
        };
        // The empty-catalog filter preserves the anchor and the scope root
        // (TS `preservedSessionIds`); the search filter keeps ancestors so
        // a match never orphans its parent row.
        let mut preserved = Vec::new();
        if let Some(anchor) = self.options.anchor_session_id.as_deref() {
            preserved.push(anchor);
        }
        if let Some(scope) = self.options.scope.as_ref() {
            if let Some(session) = scope.session_id.as_deref() {
                preserved.push(session);
            }
        }
        let filtered = filter_empty_sessions(working, &preserved);
        let filtered = if self.query.trim().is_empty() {
            filtered
        } else {
            let parsed = parse_search_query(self.query.trim());
            filter_unified_sessions(&filtered, &parsed)
        };
        let rollups = compute_rollups(&filtered);
        let mut rows = build_rows(
            &filtered,
            self.options.scope.as_ref(),
            &self.expanded_parents,
            &rollups,
            self.options.anchor_session_id.as_deref(),
        );
        // The entry anchor's row may be nested: arm the same ancestor
        // expansion below so this pass reveals it (a top-level anchor has
        // no ancestors, and a scoped view never lists the anchor at all —
        // the scope root is excluded — so the wait just stands by).
        if let (true, Some(anchor)) = (
            self.anchor_selection_pending
                && self.options.scope.is_none()
                && self.pending_ancestors.is_none(),
            self.options.anchor_session_id.as_deref(),
        ) {
            self.pending_ancestors = Some(scope_ancestors(
                &records,
                &AgentsViewScope {
                    session_id: Some(anchor.to_string()),
                    active_session_id: None,
                    session_name: None,
                },
            ));
        }
        // Re-expand the drilled-in row's ancestors (TS
        // `applyPendingAncestorExpansion`): a nested ancestor's row only
        // appears once its own parent is expanded, so expand-and-rebuild
        // until a pass reveals nothing new.
        if let Some(wanted) = self.pending_ancestors.take() {
            let mut added = true;
            while added {
                added = false;
                for row in &rows {
                    if row.kind == RowKind::SubagentSummary {
                        continue;
                    }
                    let session_id = row.summary.get("sessionId").and_then(Value::as_str);
                    if session_id.is_some_and(|id| wanted.iter().any(|w| w == id))
                        && self.expanded_parents.insert(row.identity.clone())
                    {
                        added = true;
                    }
                }
                if added {
                    rows = build_rows(
                        &filtered,
                        self.options.scope.as_ref(),
                        &self.expanded_parents,
                        &rollups,
                        self.options.anchor_session_id.as_deref(),
                    );
                }
            }
        }
        // Keep the selection on the same row across rebuilds, falling back
        // to the carried identity/key (TS `resolveAgentsViewSelectionState`).
        self.selected = resolve_selection(
            &rows,
            self.selected,
            identity.as_deref().or(self.selected_identity.as_deref()),
            self.selected_key.as_ref(),
        );
        // The entry anchor lands the selection on the anchor session's row
        // once it appears (the agents-back handoff: the view opens on the
        // session just left); until then the rebuild's default holds. The
        // sync below then pins the anchor row, so later rebuilds restore
        // onto it through the carried identity/key alone.
        if let (true, Some(anchor)) = (
            self.anchor_selection_pending,
            self.options.anchor_session_id.as_deref(),
        ) {
            if let Some(index) = rows.iter().position(|row| {
                row.selectable()
                    && row.summary.get("sessionId").and_then(Value::as_str) == Some(anchor)
            }) {
                self.selected = index;
                self.anchor_selection_pending = false;
            }
        }
        self.rows = rows;
        self.sync_selected_row_state();
    }

    /// Apply one roster push (`changed` upserts, `removed` deletes,
    /// `resync` replaces the whole roster).
    fn apply_roster_update(&mut self, changed: Vec<Value>, removed: Vec<String>, resync: bool) {
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
        self.rebuild_rows();
    }

    /// Track the selected row's identity and key (TS
    /// `syncSelectedRowState`): they survive rebuilds and view re-entry,
    /// and EVERY selection move refreshes them. A stale key from an
    /// earlier position would otherwise win the active-session-id
    /// fallback on the next roster rebuild and teleport the selection
    /// back to where the user arrowed from.
    fn sync_selected_row_state(&mut self) {
        if let Some(row) = self.rows.get(self.selected) {
            self.selected_identity = Some(row.identity.clone());
            self.selected_key = Some(crate::agents_view_forest::selection_key(&row.summary));
        } else {
            self.selected_identity = None;
            self.selected_key = None;
        }
    }

    /// Move the selection by `delta` selectable rows (TS `moveSelection`,
    /// which ends with `syncSelectedRowState`): the move refreshes the
    /// carried identity/key so the next roster rebuild resolves the
    /// selection back onto the row the user actually landed on. The first
    /// move is an explicit user choice: it cancels the entry anchor's wait,
    /// which must never override it.
    fn move_selection(&mut self, delta: isize) {
        self.anchor_selection_pending = false;
        let selectable: Vec<usize> = self
            .rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.selectable())
            .map(|(index, _)| index)
            .collect();
        if selectable.is_empty() {
            self.selected = 0;
            self.sync_selected_row_state();
            return;
        }
        let current = selectable
            .iter()
            .position(|index| *index == self.selected)
            .unwrap_or(0);
        let next = (current as isize + delta).clamp(0, selectable.len() as isize - 1) as usize;
        self.selected = selectable[next];
        self.sync_selected_row_state();
    }

    /// Open the selected row (TS `openSelected`): the summary row toggles
    /// its list, a nested child drills into its transcript with its
    /// ancestor chain, and a top-level agent opens its session.
    fn open_selected(&mut self) {
        let Some(row) = self.rows.get(self.selected).cloned() else {
            return;
        };
        match row.kind {
            RowKind::SubagentSummary => self.toggle_subagent_list(&row),
            RowKind::Subagent => self.open_subagent_row(&row),
            RowKind::Agent => self.open_row(&row, Vec::new()),
        }
    }

    /// Toggle the selected parent's subagent list (TS `toggleSubagentList`):
    /// alt+right and open both land here; the target is the selected row's
    /// parent for a summary row, the row itself otherwise.
    fn toggle_subagent_list(&mut self, row: &AgentsViewRow) {
        let target = match row.kind {
            RowKind::SubagentSummary => row.parent_identity.clone(),
            _ => Some(row.identity.clone()),
        };
        let Some(target) = target else {
            return;
        };
        if self.expanded_parents.remove(&target) {
            // Collapsing also hides the spawn program (TS clears
            // `programShownParents` with the expansion); the program
            // surface is not part of this lane.
        } else {
            self.expanded_parents.insert(target);
        }
        self.rebuild_rows();
    }

    /// Drill into a nested child row (TS `openSelectedSubagent`): the open
    /// result carries the child's ancestor chain, so the tree re-expands to
    /// the row when the chat returns to the view.
    fn open_subagent_row(&mut self, row: &AgentsViewRow) {
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
    fn find_subagent_root_row(&self, row: &AgentsViewRow) -> Option<&AgentsViewRow> {
        let mut identity = row.parent_identity.clone();
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
                _ => identity = parent.parent_identity.clone(),
            }
        }
        None
    }

    /// Open a session row: attach a live session, or reopen the saved
    /// file (TS `finish({ type: "open" })`), carrying the row's identity,
    /// key, and depth metadata for the flow.
    fn open_row(&mut self, row: &AgentsViewRow, ancestors: Vec<String>) {
        self.open_row_with(row, ancestors, None, None);
    }

    /// The open action shared by the drill-in paths.
    fn open_row_with(
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
    fn finish_open(
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
        });
        self.running = false;
    }

    /// Hand the terminal back to the scope root's session (TS
    /// `finish({ type: "scope_back" })` when `pop`: the scoped view
    /// detaches and the flow pops the scope frame — the return chat it
    /// opened from reopens, and a later agents-back lands in the parent
    /// scope. Escape reopens the same session without popping the frame.
    fn open_scope_root(&mut self, pop: bool) {
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
        });
        self.running = false;
    }

    /// The selection page step (TS `handleListNavigation`: the page keys
    /// move by `Math.max(1, visibleListRows())`, where `visibleListRows()`
    /// is the terminal rows minus the fixed frame chrome — splash, search
    /// prompt, hints — floored at 4 rows).
    fn page_step(&self) -> usize {
        self.last_height.saturating_sub(9).max(4).max(1)
    }

    /// Handle one key id. Every action dispatches through the effective
    /// keybindings in TS dispatch order (`AgentsViewMode.handleInput`,
    /// then `CustomEditor.handleInput`/`Editor.handleInput`), so a user
    /// `keybindings.json` override moves both the handler and the hint —
    /// the same contract as the session view (#184).
    fn handle_key(&mut self, key: &str) {
        let was_armed = self.exit_armed;
        // Any other key clears the exit hint (TS `clearCtrlCExitHint`).
        self.exit_armed = false;
        let has_query = !self.query.is_empty();
        // TS `app.clear` (default ctrl+c): the first press arms the exit
        // hint, a second press while armed exits the view (TS
        // `handleCtrlC`). One handled Ctrl+C press: the force-quit guard
        // disarms once the whole observed pair was handled without an
        // exit (this press armed the state); an exit re-arms from the
        // run loop's break.
        if self.keybindings.matches(key, "app.clear") {
            if key == "ctrl+c" {
                self.exit_guard.note_ctrl_c_handled();
            }
            if was_armed {
                self.running = false;
            } else {
                self.exit_armed = true;
            }
            return;
        }
        // TS `app.agents.new` (default ctrl+n): start a session; a plain
        // "n" is search text like any other character.
        if self.keybindings.matches(key, "app.agents.new") {
            self.opened = None;
            self.running = false;
            self.new_session = true;
            return;
        }
        // TS `app.agents.expand` (default alt+right, search empty): toggle
        // the selected parent's list when it has children.
        if !has_query && self.keybindings.matches(key, "app.agents.expand") {
            let selected = self.rows.get(self.selected).cloned();
            if let Some(row) = selected {
                if row.kind == RowKind::SubagentSummary || row.descendant_count > 0 {
                    self.toggle_subagent_list(&row);
                }
            }
            return;
        }
        // TS `app.agents.open` (right) and the editor submit (enter, the
        // `tui.select.confirm` slot) both open the selection (a non-empty
        // query still opens while the cursor sits at its end — always
        // true for this editor); the summary row toggles its list instead.
        if self.keybindings.matches(key, "app.agents.open")
            || self.keybindings.matches(key, "tui.select.confirm")
        {
            self.open_selected();
            return;
        }
        // List navigation (TS `handleListNavigation`): the selection keys
        // and the page keys move the selection.
        if self.keybindings.matches(key, "tui.select.up") {
            self.move_selection(-1);
            return;
        }
        if self.keybindings.matches(key, "tui.select.down") {
            self.move_selection(1);
            return;
        }
        if self.keybindings.matches(key, "tui.select.pageUp") {
            self.move_selection(-(self.page_step() as isize));
            return;
        }
        if self.keybindings.matches(key, "tui.select.pageDown") {
            self.move_selection(self.page_step() as isize);
            return;
        }
        // The scoped view's parent key (TS `app.agents.back`, default
        // left): with an empty search it hands the terminal back to the
        // scope root's session and pops the scope; the global view has no
        // hierarchy parent and consumes the key without opening a chat.
        if !has_query && self.keybindings.matches(key, "app.agents.back") {
            if self.scope_active {
                self.open_scope_root(true);
            }
            return;
        }
        // TS `app.input.clear` (default escape, the editor's `onEscape`):
        // clear the search; scoped, reopen the last-opened session (the
        // scope root in this flow) without touching the scope frame;
        // otherwise exit.
        if self.keybindings.matches(key, "app.input.clear") {
            if !self.query.is_empty() {
                self.query.clear();
                self.rebuild_rows();
            } else if self.scope_active {
                self.open_scope_root(false);
            } else {
                self.running = false;
            }
            return;
        }
        // TS `app.exit` (default ctrl+d, empty editor — the editor's
        // `onCtrlD`): leave the view without opening a session.
        if !has_query && self.keybindings.matches(key, "app.exit") {
            self.running = false;
            return;
        }
        // Editor text keys (TS `Editor.handleInput`): backspace deletes the
        // last character, ctrl+u clears the line, and any single
        // character is search text.
        if self
            .keybindings
            .matches(key, "tui.editor.deleteCharBackward")
        {
            self.query.pop();
            self.rebuild_rows();
            return;
        }
        if self
            .keybindings
            .matches(key, "tui.editor.deleteToLineStart")
        {
            self.query.clear();
            self.rebuild_rows();
            return;
        }
        if key.chars().count() == 1 {
            self.query.push_str(key);
            self.rebuild_rows();
        }
    }

    /// Compose one frame (splash, search prompt, sectioned list, hints).
    fn render_frame(&mut self, width: usize, height: usize) -> (Vec<Line>, Option<(usize, usize)>) {
        // The frame height feeds the page step (TS reads
        // `ui.terminal.rows` live at key time instead).
        self.last_height = height;
        let theme = &self.theme;
        let mut lines: Vec<Line> = Vec::new();
        // TS `getAgentCountsText` rides the splash as extra metadata. Like
        // TS `countRowsBySection`, it counts agent-kind rows only — nested
        // subagent and summary rows never inflate the header.
        let count_agents = |section: Section| {
            self.rows
                .iter()
                .filter(|row| row.kind == RowKind::Agent && row.section == section)
                .count()
        };
        let (running, idle, inactive) = (
            count_agents(Section::Running),
            count_agents(Section::Idle),
            count_agents(Section::Inactive),
        );
        let mut extra_metadata = vec![(
            "agents".to_string(),
            format!("{running} running, {idle} idle, {inactive} inactive"),
        )];
        if let Some(depth) = self.scope_depth {
            extra_metadata.push(("depth".to_string(), depth.to_string()));
        }
        let chrome = crate::chrome::ChromeState {
            version: self.options.version.clone(),
            cwd: self.options.cwd.to_string_lossy().to_string(),
            extra_metadata,
            splash_hide_cwd: self.scope_active,
            ..Default::default()
        };
        // `render_splash` already trails one blank row (TS renderContent's
        // `headerLines.push("")`).
        lines.extend(crate::chrome::render_splash(&chrome, theme, width));
        // The scoped view's back label (TS `<back> back · <title> ›
        // subagents`), dim, over the full width under the splash.
        if self.scope_active {
            if let Some(scope) = &self.options.scope {
                let title = scope
                    .session_name
                    .clone()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| "Untitled agent".to_string());
                let label = truncate_text(
                    &format!("\u{2190} back \u{b7} {title} \u{203a} subagents"),
                    width,
                );
                let mut row = vec![crate::Span::styled(label, theme.fg_style(ThemeColor::Dim))];
                row = crate::width::pad_line(row, width);
                lines.push(row);
                lines.push(vec![]);
            }
        }

        // Inline search prompt (TS renders the transparent editor with the
        // `> ` prefix, paddingX 2, and the dim "Search sessions" placeholder).
        let mut prompt: Line = vec![crate::Span::styled(
            " >  ".to_string(),
            theme.fg_style(ThemeColor::Muted),
        )];
        let head = truncate_text(&self.query, width.saturating_sub(5).max(1));
        prompt.push(crate::Span::styled(head, theme.fg_style(ThemeColor::Muted)));
        if self.query.is_empty() {
            prompt.push(crate::Span::styled(
                " ".to_string(),
                theme.fg_style(ThemeColor::Muted),
            ));
            prompt.push(crate::Span::styled(
                "Search sessions".to_string(),
                theme.fg_style(ThemeColor::Dim),
            ));
        }
        let cursor = Some((
            lines.len(),
            4 + str_width(&self.query).min(width.saturating_sub(4)),
        ));
        lines.push(prompt);
        lines.push(vec![]);

        let list_rows = height.saturating_sub(lines.len() + 1);
        lines.extend(self.render_list(width, list_rows));
        while lines.len() < height.saturating_sub(1) {
            lines.push(vec![]);
        }
        lines.push(self.render_hints(width));
        while lines.len() > height {
            lines.pop();
        }
        (lines, cursor)
    }

    /// The sectioned session list (TS `renderSessionRows`): the rows group
    /// into section blocks behind their headings, and the viewport follows
    /// the selection — the slice centers on the selected row and clips
    /// the overflow behind leading/trailing ellipses, so a roster rebuild
    /// (spawn churn, activity re-sorts) never scrolls the user's position
    /// off-screen. Nested rows (summary rows and expanded subagents)
    /// render inside their top-level agent's section block, and the
    /// headings count top-level agents only (TS `getDisplayRowsForSection`
    /// / `countRowsBySection`).
    fn render_list(&mut self, width: usize, max_rows: usize) -> Vec<Line> {
        if max_rows == 0 {
            return Vec::new();
        }
        if self.rows.is_empty() {
            let text = if self.query.trim().is_empty() {
                "No sessions yet."
            } else {
                "No sessions match your search."
            };
            return vec![vec![self.theme.fg(ThemeColor::Dim, text.to_string())]];
        }
        /// One rendered display entry of the sectioned list (TS
        /// `DisplayItem`): the spacer between section blocks, a section
        /// heading, or one row.
        enum DisplayItem<'a> {
            Spacer,
            Heading(Section),
            Row(&'a AgentsViewRow),
        }
        let layout = build_layout(&self.rows, width);
        // The display-item sequence (TS `displayItems`): each non-empty
        // section contributes a spacer (when not first), its heading, then
        // its rows.
        let counts: Vec<(Section, usize)> = [Section::Running, Section::Idle, Section::Inactive]
            .into_iter()
            .map(|section| {
                (
                    section,
                    self.rows
                        .iter()
                        .filter(|row| row.kind == RowKind::Agent && row.section == section)
                        .count(),
                )
            })
            .collect();
        let mut display: Vec<DisplayItem> = Vec::new();
        for (section, count) in &counts {
            if *count == 0 {
                continue;
            }
            if !display.is_empty() {
                display.push(DisplayItem::Spacer);
            }
            display.push(DisplayItem::Heading(*section));
            let mut include = false;
            for row in &self.rows {
                if row.depth == 0 {
                    include = row.kind == RowKind::Agent && row.section == *section;
                }
                if include {
                    display.push(DisplayItem::Row(row));
                }
            }
        }
        // The viewport (TS `renderSessionRows`): reserve the column header
        // and its spacer, center the slice on the selected row, and clip
        // the overflow behind ellipsis lines. The selected row's display
        // index drives the window, so a rebuild that re-sorts the rows
        // keeps the selection on-screen instead of snapping the window
        // back to the top of the list.
        let header_rows = max_rows.saturating_sub(1).min(2);
        let visible_rows = max_rows - header_rows;
        let selected_identity = self
            .rows
            .get(self.selected)
            .map(|row| row.identity.as_str());
        let selected_display_index = display
            .iter()
            .position(
                |item| matches!(item, DisplayItem::Row(row) if Some(row.identity.as_str()) == selected_identity),
            )
            .map(|index| index as isize)
            .unwrap_or(-1);
        let anchor = selected_display_index - (visible_rows / 2) as isize;
        let upper = display.len() as isize - visible_rows as isize;
        let start = anchor.min(upper).max(0) as usize;
        let show_leading = start > 0 && visible_rows > 1;
        let show_trailing = start + visible_rows < display.len() && visible_rows > 2;
        let content_rows = visible_rows - show_leading as usize - show_trailing as usize;
        let slice_start = if selected_display_index >= start as isize + content_rows as isize {
            (selected_display_index + 1 - content_rows as isize) as usize
        } else {
            start
        };
        let slice_end = (slice_start + content_rows).min(display.len());
        let mut lines: Vec<Line> = display[slice_start..slice_end]
            .iter()
            .map(|item| match item {
                DisplayItem::Spacer => Vec::new(),
                DisplayItem::Heading(section) => {
                    let count = counts
                        .iter()
                        .find(|(count_section, _)| count_section == section)
                        .map(|(_, count)| *count)
                        .unwrap_or(0);
                    vec![self.theme.fg(
                        ThemeColor::Muted,
                        truncate_text(&format!("{} ({count})", section_title(*section)), width),
                    )]
                }
                DisplayItem::Row(row) => self.render_row(row, &layout, width),
            })
            .collect();
        if show_leading {
            lines.insert(0, vec![self.theme.fg(ThemeColor::Dim, "  ...".to_string())]);
        }
        if show_trailing {
            lines.push(vec![self.theme.fg(ThemeColor::Dim, "  ...".to_string())]);
        }
        if header_rows > 1 {
            lines.insert(0, Vec::new());
        }
        if header_rows > 0 {
            lines.insert(
                0,
                vec![crate::Span::styled(
                    layout.legend.clone(),
                    self.theme
                        .fg_style(ThemeColor::Text)
                        .add_modifier(ratatui::style::Modifier::BOLD),
                )],
            );
        }
        lines
    }

    /// One session row (TS `renderRow`): the summary rows render their
    /// `▸/▾ title` cell over the full width; agent rows render icon, title
    /// (nested rows indented), model, activity, cost/age. The selected row
    /// carries the selection background.
    fn render_row(&self, row: &AgentsViewRow, layout: &RowLayout, width: usize) -> Line {
        let theme = &self.theme;
        let selected = Some(row.identity.as_str())
            == self.rows.get(self.selected).map(|r| r.identity.as_str());
        if row.kind == RowKind::SubagentSummary {
            // TS: `formatTableCell(`${indent}${expanded ? "▾" : "▸"} ${title}`, width)`.
            let indent = "  ".repeat(row.depth);
            let marker = if row.expanded { "\u{25be}" } else { "\u{25b8}" };
            let text = format!("{indent}{marker} {}", row.title);
            let mut line: Line = vec![crate::Span::raw(crate::agents_view_state::truncate_text(
                &text, width,
            ))];
            line = pad_line(line, width);
            if selected {
                return theme.bg_paint(ThemeBg::SelectedBg, line);
            }
            return line;
        }
        let icon = match row.section {
            Section::Running => ["\u{25c7}", "\u{25c8}", "\u{25c6}", "\u{25c8}"][self.pulse % 4],
            _ => "\u{2022}",
        };
        let icon_color = match row.section {
            Section::Running => ThemeColor::Text,
            Section::Idle => ThemeColor::Warning,
            Section::Inactive => ThemeColor::Dim,
        };
        let icon_style = theme
            .fg_style(icon_color)
            .add_modifier(ratatui::style::Modifier::BOLD);
        // TS `renderRow`: `${"  ".repeat(depth)}${icon} ${title}` padded to
        // the name column, then the model and activity cells, then the dim
        // cost/age details.
        let indent = "  ".repeat(row.depth);
        let indent_width = str_width(&indent);
        let mut line: Line = Vec::new();
        if indent_width > 0 {
            line.push(crate::Span::raw(indent));
        }
        line.push(crate::Span::styled(icon, icon_style));
        line.push(crate::Span::styled(
            " ".to_string(),
            ratatui::style::Style::default(),
        ));
        // TS `formatTableCell(title, nameWidth)`: the name cell (indent +
        // icon + title) clips to the column width, so a long session name
        // can never push the model, activity, and cost/age columns
        // off-screen. The icon and its space take the first two cells.
        let title = truncate_text(
            &row.title,
            layout.name_width.saturating_sub(2 + indent_width),
        );
        // Session titles render uniformly (no bold for named sessions);
        // explicit product decision — differs from TS `styleRowTitle`, which
        // bolds explicit session names.
        line.push(crate::Span::styled(
            title.clone(),
            theme.fg_style(ThemeColor::Text),
        ));
        line.push(crate::Span::styled(
            " ".repeat(
                layout
                    .name_width
                    .saturating_sub(str_width(&title) + 2 + indent_width),
            ),
            ratatui::style::Style::default(),
        ));
        line.push(crate::Span::styled(
            "  ".to_string(),
            ratatui::style::Style::default(),
        ));
        line.push(theme.fg(ThemeColor::Muted, cell(&row.model, layout.model_width)));
        if layout.activity_width > 0 {
            line.push(crate::Span::styled(
                "  ".to_string(),
                ratatui::style::Style::default(),
            ));
            line.push(theme.fg(ThemeColor::Dim, cell(&row.activity, layout.activity_width)));
        }
        line.push(crate::Span::styled(
            "  ".to_string(),
            ratatui::style::Style::default(),
        ));
        let details = layout
            .details
            .get(&row.identity)
            .cloned()
            .unwrap_or_default();
        line.push(theme.fg(ThemeColor::Dim, details));
        if selected {
            line = pad_line(line, width);
            return theme.bg_paint(ThemeBg::SelectedBg, line);
        }
        line
    }

    /// The bottom hint/status line.
    fn render_hints(&self, width: usize) -> Line {
        let theme = &self.theme;
        if self.exit_armed {
            // TS `renderHints`: the exit hint renders the effective
            // `app.clear` key ("Press Ctrl+C again to exit"); a disabled
            // binding (an empty override) falls back to the plain hint.
            let hint = match self.keybindings.first_key("app.clear") {
                Some(key) => format!(
                    "Press {} again to exit",
                    crate::keybindings::format_key_text(&key)
                ),
                None => "Press again to exit".to_string(),
            };
            return truncate_line(vec![theme.fg(ThemeColor::Muted, hint)], width);
        }
        if let Some(status) = &self.status {
            return truncate_line(vec![theme.fg(ThemeColor::Error, status.clone())], width);
        }
        // TS `renderHints`: every hint slot renders the effective binding
        // (`keyText`, arrows for up/down/left/right), so a user override
        // moves the hint with the handler. The summary row swaps the open
        // action for expand/collapse (TS `renderHints`'s `rightAction`);
        // the scoped view adds the parent-back hint.
        let right_action = match self.rows.get(self.selected) {
            Some(row) if row.kind == RowKind::SubagentSummary => {
                if row.expanded {
                    "collapse"
                } else {
                    "expand"
                }
            }
            _ => "open",
        };
        let key_text = |id: &str| {
            crate::keybindings::format_key_text(&self.keybindings.get_keys(id).join("/"))
        };
        let hints = if self.scope_active {
            format!(
                "{}/{} navigate   {}/{} {right_action}   {} parent   {} new",
                key_text("tui.select.up"),
                key_text("tui.select.down"),
                key_text("tui.select.confirm"),
                key_text("app.agents.open"),
                key_text("app.agents.back"),
                key_text("app.agents.new"),
            )
        } else {
            format!(
                "{}/{} navigate   {}/{} {right_action}   {} new",
                key_text("tui.select.up"),
                key_text("tui.select.down"),
                key_text("tui.select.confirm"),
                key_text("app.agents.open"),
                key_text("app.agents.new"),
            )
        };
        truncate_line(vec![theme.fg(ThemeColor::Muted, hints.to_string())], width)
    }
}

fn cell(value: &str, width: usize) -> String {
    let truncated = truncate_text(value, width);
    format!(
        "{truncated}{}",
        " ".repeat(width.saturating_sub(str_width(&truncated)))
    )
}

fn truncate_line(line: Line, width: usize) -> Line {
    let text = line.iter().map(|s| s.content.as_str()).collect::<String>();
    crate::width::wrap_text(&text, width.max(1))
        .into_iter()
        .next()
        .unwrap_or_default()
}

enum Renderer {
    Terminal(ratatui::Terminal<crate::hyperlinks::LinkBackend>),
    Headless {
        width: u16,
        height: u16,
        frames: Vec<String>,
    },
}

impl Renderer {
    fn setup(
        ui: AgentsViewUiMode,
        ui_tx: mpsc::UnboundedSender<UiInput>,
        exit_guard: crate::exit_guard::ExitGuard,
    ) -> Result<Renderer> {
        match ui {
            AgentsViewUiMode::Terminal => {
                crossterm::terminal::enable_raw_mode()?;
                // Adopt the alternate screen the previous surface left in
                // place (TS `pendingAltScreenHandoff`); only the first
                // surface of the process enters it, so a view switch never
                // flashes the primary screen.
                crate::altscreen::enter()?;
                // The enhanced-key modes come up with the raw-mode
                // bracket (TS `ProcessTerminal.start`): pastes arrive as
                // one chunk, the kitty probe runs before the reader
                // thread starts polling.
                crate::enhanced_keys::enable(&mut std::io::stdout())?;
                // One reader thread feeds the view; the reader registry
                // joins the previous surface's reader (the chat it opened)
                // before this one starts polling. The reader also observes
                // Ctrl+C pairs for the exit guard: this thread stays alive
                // when the view loop is wedged in a daemon request, so the
                // force-quit contract holds regardless of loop state.
                crate::input::spawn_terminal_reader(move |event| match event {
                    crossterm::event::Event::Key(key) => {
                        exit_guard.observe_key(&key);
                        let id = crate::keys::key_event_to_id(&key).unwrap_or_default();
                        ui_tx.send(UiInput::Key(id)).is_ok()
                    }
                    _ => true,
                });
                let terminal = ratatui::Terminal::new(crate::hyperlinks::stdout_backend())?;
                // The adopted buffer still holds the previous view's frame;
                // the first draw repaints the same buffer (a fresh alt
                // screen is already blank). TS paints the new frame
                // straight over the old one, so the clear escape must
                // never reach the pane on its own: queue it with the
                // cursor show and let the first draw's single flush carry
                // clear + frame together. A separate clear-and-flush here
                // shows a blank pane for the whole render gap — a visible
                // flicker on every surface switch.
                crossterm::queue!(
                    std::io::stdout(),
                    crossterm::terminal::Clear(crossterm::terminal::ClearType::All),
                    crossterm::cursor::Show
                )?;
                Ok(Renderer::Terminal(terminal))
            }
            AgentsViewUiMode::Headless(plan) => {
                let steps = plan.steps;
                tokio::spawn(async move {
                    for step in steps {
                        match step {
                            AgentsStep::Type(text) => {
                                for ch in text.chars() {
                                    if ui_tx.send(UiInput::Key(ch.to_string())).is_err() {
                                        return;
                                    }
                                }
                            }
                            AgentsStep::Key(key) => {
                                if ui_tx.send(UiInput::Key(key)).is_err() {
                                    return;
                                }
                            }
                            AgentsStep::WaitSettle { timeout_ms } => {
                                let _ = ui_tx.send(UiInput::Settled);
                                tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                            }
                        }
                    }
                    let _ = ui_tx.send(UiInput::Done);
                });
                Ok(Renderer::Headless {
                    width: plan.width,
                    height: plan.height,
                    frames: Vec::new(),
                })
            }
        }
    }

    fn draw(&mut self, mode: &mut AgentsViewMode) -> Option<(usize, usize)> {
        match self {
            Renderer::Terminal(terminal) => {
                let area = terminal.size().expect("terminal size");
                let (lines, cursor) = mode.render_frame(area.width as usize, area.height as usize);
                crate::hyperlinks::install_frame(&lines);
                terminal
                    .draw(|f| {
                        let area = ratatui::layout::Rect::new(0, 0, area.width, area.height);
                        let rendered: Vec<ratatui::text::Line<'static>> =
                            lines.iter().map(crate::markdown::to_ratatui_line).collect();
                        f.render_widget(ratatui::text::Text::from(rendered), area);
                        if let Some((row, col)) = cursor {
                            if row < area.height as usize && col < area.width as usize {
                                f.set_cursor_position(ratatui::layout::Position::new(
                                    col as u16, row as u16,
                                ));
                            }
                        }
                    })
                    .expect("draw frame");
                None
            }
            Renderer::Headless {
                width,
                height,
                frames,
            } => {
                let (lines, _) = mode.render_frame(*width as usize, *height as usize);
                let text = lines
                    .iter()
                    .map(|line| line.iter().map(|s| s.content.as_str()).collect::<String>())
                    .collect::<Vec<_>>()
                    .join("\n");
                if frames.last().map(String::as_str) != Some(text.as_str()) {
                    frames.push(text);
                }
                None
            }
        }
    }

    /// Teardown. `preserve_alt_screen` mirrors TS `ui.stop({ preserveAltScreen })`:
    /// a handoff to the chat the view just selected keeps the alternate screen
    /// (and raw mode, so the handoff gap cannot echo into the preserved frame)
    /// for the adopting surface, hiding the cursor; a real exit releases the
    /// screen and restores the terminal. `flushFullscreen` stays false either
    /// way (TS agents-view-mode `finish`): the picker frame is never flushed
    /// onto the main screen.
    fn finish(self, preserve_alt_screen: bool) -> Vec<String> {
        match self {
            Renderer::Terminal(_) => {
                // The enhanced-key modes release with the raw-mode bracket
                // (TS `stop` on every exit, handoffs included).
                let mut out = std::io::stdout();
                let _ = crate::enhanced_keys::disable(&mut out);
                if preserve_alt_screen {
                    let _ = crossterm::execute!(std::io::stdout(), crossterm::cursor::Hide);
                } else {
                    let _ = crossterm::terminal::disable_raw_mode();
                    let _ = crate::altscreen::leave();
                    let _ = crossterm::execute!(std::io::stdout(), crossterm::cursor::Show);
                }
                Vec::new()
            }
            Renderer::Headless { frames, .. } => frames,
        }
    }
}

/// Run the agents view until the user exits or opens a session.
pub async fn run_agents_view(
    options: AgentsViewOptions,
    ui: AgentsViewUiMode,
    link: Option<AgentsViewLink>,
) -> Result<AgentsViewRun> {
    crossterm::style::force_color_output(true);
    // The flow's parked connection first (TS `persistentState.rosterClient`
    // staying connected across the loop); a fresh run connects its own.
    let (mut client, mut events) = match link {
        Some(AgentsViewLink { client, events }) => (client, events),
        None => {
            let link = AgentsViewLink::connect(&options.socket_path)
                .await
                .with_context(|| "the agents view could not attach to the daemon")?;
            (link.client, link.events)
        }
    };

    // The double-Ctrl+C force-quit guard: same contract as the session
    // loop (see `interactive::run_interactive`).
    let exit_guard = crate::exit_guard::ExitGuard::new();
    let mut mode = AgentsViewMode::new(options.clone());
    mode.exit_guard = exit_guard.clone();

    // The roster snapshot precedes streaming pushes; updates that race the
    // snapshot apply on top (idempotent by agent id, TS roster-store). A
    // parked connection that died (daemon update) reconnects once here.
    let roster_subscribe = || DaemonCommand::RosterSubscribe {
        id: None,
        rest: Default::default(),
    };
    let mut snapshot = client.request(roster_subscribe()).await;
    if snapshot.is_err() {
        client.close();
        let link = AgentsViewLink::connect(&options.socket_path)
            .await
            .with_context(|| "the agents view could not attach to the daemon")?;
        client = link.client;
        events = link.events;
        snapshot = client.request(roster_subscribe()).await;
    }
    let snapshot = snapshot?;
    if !snapshot.success {
        client.close();
        anyhow::bail!(
            "roster_subscribe failed: {}",
            snapshot.error.unwrap_or_default()
        );
    }
    mode.roster = snapshot
        .data
        .as_ref()
        .and_then(|data| data.get("roster"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    mode.rebuild_rows();

    let (ui_tx, mut ui_rx) = mpsc::unbounded_channel::<UiInput>();
    let mut renderer = Renderer::setup(ui, ui_tx.clone(), exit_guard.clone())?;
    // The first frame renders from the live roster the moment the surface
    // mounts (TS `applySessionList(this.rosterStore.summaries(), true)`
    // before its first `requestRender`): the saved-catalog fetch below
    // applies as an input when it lands instead of holding the frame.
    renderer.draw(&mut mode);
    // The saved catalog feeds the Inactive section (cwd + sessionDir
    // scope). TS `armSavedSearchFetch` runs the scan while the view is
    // already interactive, so a large catalog never delays the first
    // frame; the result (or its failure) re-enters the loop as an input.
    {
        let client = client.clone();
        let cwd = mode.options.cwd.clone();
        let session_dir = mode.options.session_dir.clone();
        let ui_tx = ui_tx.clone();
        tokio::spawn(async move {
            let saved = client
                .request(DaemonCommand::ListSavedSessions {
                    id: None,
                    cwd: Some(cwd.to_string_lossy().to_string()),
                    session_dir: session_dir.map(|dir| dir.to_string_lossy().to_string()),
                    active_session_id: None,
                    scope: Value::Null,
                    rest: Default::default(),
                })
                .await;
            let input = match saved {
                Ok(response) if response.success => UiInput::SavedLoaded {
                    sessions: response
                        .data
                        .as_ref()
                        .and_then(|data| data.get("sessions"))
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                },
                Ok(response) => UiInput::SavedFailed {
                    error: response.error.unwrap_or_else(|| "unknown error".into()),
                },
                Err(error) => UiInput::SavedFailed {
                    error: error.to_string(),
                },
            };
            let _ = ui_tx.send(input);
        });
    }
    // Broadcast frames that landed on the parked connection while the view
    // was closed (heartbeats): the fresh roster snapshot supersedes them.
    while events.try_recv().is_ok() {}
    let mut pending: Vec<UiInput> = Vec::new();
    let mut last_pulse = tokio::time::Instant::now();

    while mode.running {
        if let Some(input) = first_input(&mut pending) {
            match input {
                UiInput::Key(key) => mode.handle_key(&key),
                UiInput::Settled => {}
                // The saved-catalog scan landed (TS `armSavedSearchFetch`
                // applying its result): the Inactive section builds now.
                UiInput::SavedLoaded { sessions } => {
                    mode.saved = sessions;
                    mode.rebuild_rows();
                }
                UiInput::SavedFailed { error } => {
                    mode.status = Some(format!("Saved sessions unavailable: {error}"));
                }
                // The headless plan ended: the run stops here (the
                // interactive harness's `HeadlessDone` contract). A plan
                // that ends without an exit key still captures its frames
                // and returns instead of spinning forever.
                UiInput::Done => mode.running = false,
            }
            if let Renderer::Terminal(_) = renderer {
                renderer.draw(&mut mode);
            }
        }
        if !mode.running {
            break;
        }
        tokio::select! {
            maybe_event = events.recv() => {
                match maybe_event {
                    Some(DaemonClientEvent::RosterUpdate { changed, removed, resync }) => {
                        mode.apply_roster_update(changed, removed, resync);
                    }
                    Some(_) => {}
                    None => {
                        mode.status = Some("the daemon connection closed".to_string());
                        mode.running = false;
                    }
                }
            }
            maybe_input = ui_rx.recv() => {
                if let Some(input) = maybe_input {
                    pending.push(input);
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
        // The running-row icon animates at the TS working-icon cadence.
        if mode.rows.iter().any(|row| row.section == Section::Running)
            && last_pulse.elapsed() >= Duration::from_millis(PULSE_INTERVAL_MS)
        {
            last_pulse = tokio::time::Instant::now();
            mode.pulse = mode.pulse.wrapping_add(1);
        }
        renderer.draw(&mut mode);
    }

    // The view decided to leave: arm the force-quit deadline so the
    // teardown below (terminal restore, roster unsubscribe over a possibly
    // dead daemon) is best-effort and cannot hold the process open.
    if matches!(renderer, Renderer::Terminal(_)) {
        exit_guard.arm_for_exit();
    }
    // A selection hands the pane to the chat it opened (TS `result.type !== "exit"`);
    // exiting releases the alternate screen.
    let frames = renderer.finish(mode.opened.is_some() || mode.new_session);
    // TS `AgentsViewRosterStore.dispose` fires the roster unsubscribe
    // fire-and-forget ("nobody needs the ack"; the supervisor also drops
    // the subscription with the socket), so no handoff ever waits on it.
    {
        let client = client.clone();
        tokio::spawn(async move {
            let _ = client
                .request(DaemonCommand::RosterUnsubscribe {
                    id: None,
                    rest: Default::default(),
                })
                .await;
        });
    }
    // A selection hands the terminal to a session run: the process keeps
    // going, so retire the watchdog. A selection-less exit ends the
    // process, where the deadline dies with it — or fires if it wedged.
    if mode.opened.is_some() || mode.new_session {
        exit_guard.cancel();
    }
    let opened = mode.opened.take();
    // A handoff returns the roster connection for the flow's next view run
    // (TS `persistentState.rosterClient`); a selection-less exit closes it.
    let link = if opened.is_some() || mode.new_session {
        Some(AgentsViewLink { client, events })
    } else {
        client.close();
        None
    };
    Ok(AgentsViewRun {
        link,
        outcome: AgentsViewOutcome {
            selection: opened
                .as_ref()
                .map(|row| row.selection.clone())
                .or(mode.new_session.then_some(SessionSelection::New)),
            frames,
            query: (!mode.query.is_empty()).then(|| mode.query.clone()),
            scope_popped: mode.scope_popped,
            scope_dropped: mode.scope_dropped,
            expanded_ancestors: opened
                .as_ref()
                .map(|row| row.expanded_ancestors.clone())
                .unwrap_or_default(),
            selected_row_identity: opened.as_ref().map(|row| row.selected_row_identity.clone()),
            selected_key: opened.as_ref().map(|row| row.selected_key.clone()),
            opened_rlm_depth: opened.as_ref().and_then(|row| row.rlm_depth),
            opened_has_children: opened.as_ref().map(|row| row.has_children).unwrap_or(false),
            status_message: opened.as_ref().and_then(|row| row.status_message.clone()),
        },
    })
}

/// Pop the next queued input, or `None` when the queue is empty.
fn first_input(pending: &mut Vec<UiInput>) -> Option<UiInput> {
    if pending.is_empty() {
        None
    } else {
        Some(pending.remove(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One idle row under test plus a holder row that keeps the selection,
    /// with the given title and one model id. The activity text and cost/age
    /// stay fixed so the expected rows are exact.
    fn mode_with_row(title: &str, model: &str) -> (AgentsViewMode, usize) {
        let mut mode = AgentsViewMode::new(AgentsViewOptions {
            socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
            cwd: PathBuf::from("/tmp"),
            session_dir: None,
            theme: "prime".to_string(),
            version: "0.0.0".to_string(),
            anchor_session_id: None,
            scope: None,
            query: None,
            expanded_ancestors: Vec::new(),
            selected_row_identity: None,
            selected_key: None,
            status_message: None,
            keybindings: crate::keybindings::KeybindingsManager::new(),
        });
        let row = |title: &str| AgentsViewRow {
            section: Section::Idle,
            identity: title.to_string(),
            summary: serde_json::json!({ "sessionName": title }),
            title: title.to_string(),
            status_label: String::new(),
            model: model.to_string(),
            activity: "idle now".to_string(),
            cost: 0.0,
            age: "1s".to_string(),
            depth: 0,
            descendant_count: 0,
            running_subagent_count: 0,
            expanded: false,
            parent_identity: None,
            kind: RowKind::Agent,
        };
        mode.rows = vec![row("holder"), row(title)];
        (mode, 1)
    }

    fn flat(line: &Line) -> String {
        line.iter().map(|s| s.content.as_str()).collect()
    }

    /// The exact expected idle-row text: name cell (icon + title, clipped or
    /// padded to `name_width`), model and activity cells padded to their
    /// columns, then the cost/age details.
    fn expected_row(title_cell: &str, layout: &RowLayout) -> String {
        let bullet = "\u{2022}";
        format!(
            "{bullet} {title_cell}  {}  {}  $0.00   1s",
            cell("mock-1", layout.model_width),
            cell("idle now", layout.activity_width),
        )
    }

    #[test]
    fn long_session_names_clip_to_the_name_column() {
        let (mode, index) = mode_with_row(&"a".repeat(100), "mock-1");
        let layout = build_layout(&mode.rows, 120);
        // TS `buildCompactAgentsViewLayout` at width 120 with these rows.
        assert_eq!(layout.name_width, 28);
        assert_eq!(layout.model_width, 12);
        assert_eq!(layout.activity_width, 64);
        let line = mode.render_row(&mode.rows[index], &layout, 120);
        let text = flat(&line);
        // TS `formatTableCell` clips with an empty ellipsis marker: the
        // name cell keeps the icon and space plus 26 name characters.
        assert_eq!(text, expected_row(&"a".repeat(26), &layout));
        // Every column still renders after the clipped name.
        let model_at = text.find("mock-1").expect("model column present");
        assert_eq!(str_width(&text[..model_at]), 28 + 2);
        assert!(text.ends_with("$0.00   1s"));
    }

    #[test]
    fn short_session_names_pad_to_the_name_column() {
        let (mode, index) = mode_with_row("short name", "mock-1");
        let layout = build_layout(&mode.rows, 120);
        assert_eq!(layout.name_width, 28);
        let line = mode.render_row(&mode.rows[index], &layout, 120);
        let text = flat(&line);
        let name_cell = format!("short name{}", " ".repeat(28 - 2 - 10));
        assert_eq!(text, expected_row(&name_cell, &layout));
    }

    fn roster_entry(agent: &str, status: &str, summary: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "agentId": agent, "status": status, "summary": summary })
    }

    fn parent_summary(id: &str) -> serde_json::Value {
        serde_json::json!({
            "sessionId": id,
            "lifecycle": "live",
            "activeSessionId": format!("{id}-live"),
            "sessionFile": format!("/x/{id}.jsonl"),
            "runtimeKind": "top-level",
            "sessionName": format!("{id} name"),
            "messageCount": 2,
            "rlmDepth": 0,
        })
    }

    fn child_summary(id: &str, parent: &str, name: &str) -> serde_json::Value {
        serde_json::json!({
            "sessionId": id,
            "lifecycle": "live",
            "activeSessionId": format!("{id}-live"),
            "sessionFile": format!("/x/{id}.jsonl"),
            "runtimeKind": "subagent",
            "rlmChildId": format!("child-{id}"),
            "parentActiveSessionId": format!("{parent}-live"),
            "parentSessionId": parent,
            "parentSessionPath": format!("/x/{parent}.jsonl"),
            "sessionName": name,
            "messageCount": 1,
            "rlmDepth": 1,
        })
    }

    /// A mode over a live parent/child roster, no scope, fresh selection.
    fn mode_with_parent_and_child() -> AgentsViewMode {
        let mut mode = AgentsViewMode::new(AgentsViewOptions {
            socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
            cwd: PathBuf::from("/tmp"),
            session_dir: None,
            theme: "prime".to_string(),
            version: "0.0.0".to_string(),
            anchor_session_id: None,
            scope: None,
            query: None,
            expanded_ancestors: Vec::new(),
            selected_row_identity: None,
            selected_key: None,
            status_message: None,
            keybindings: crate::keybindings::KeybindingsManager::new(),
        });
        mode.roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "running", child_summary("c", "p", "worker one")),
        ];
        mode.rebuild_rows();
        mode
    }

    /// A fresh-open view anchored on the given session (the agents-back
    /// handoff state: no carried selection, the session just left).
    fn mode_with_anchor(anchor: Option<&str>, roster: Vec<serde_json::Value>) -> AgentsViewMode {
        let mut mode = AgentsViewMode::new(AgentsViewOptions {
            socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
            cwd: PathBuf::from("/tmp"),
            session_dir: None,
            theme: "prime".to_string(),
            version: "0.0.0".to_string(),
            anchor_session_id: anchor.map(str::to_string),
            scope: None,
            query: None,
            expanded_ancestors: Vec::new(),
            selected_row_identity: None,
            selected_key: None,
            status_message: None,
            keybindings: crate::keybindings::KeybindingsManager::new(),
        });
        mode.roster = roster;
        mode.rebuild_rows();
        mode
    }

    /// A fresh open (the agents-back handoff) anchors the entry selection
    /// on the session the view was opened from, not the first row.
    #[test]
    fn entry_anchor_selects_the_left_session() {
        let mode = mode_with_anchor(
            Some("s2"),
            vec![
                roster_entry("s1", "idle", parent_summary("s1")),
                roster_entry("s2", "idle", parent_summary("s2")),
            ],
        );
        assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s2");
        assert!(!mode.anchor_selection_pending);
    }

    /// The anchor row can arrive after the first rebuild (the roster
    /// streams, the saved catalog lands later): the wait survives the
    /// rebuilds that pin other rows and lands once the row appears.
    #[test]
    fn anchor_wait_survives_until_the_row_arrives() {
        let mut mode = mode_with_anchor(
            Some("s2"),
            vec![roster_entry("s1", "idle", parent_summary("s1"))],
        );
        assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s1");
        assert!(mode.anchor_selection_pending);
        mode.roster
            .push(roster_entry("s2", "idle", parent_summary("s2")));
        mode.rebuild_rows();
        assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s2");
        assert!(!mode.anchor_selection_pending);
    }

    /// The first user move cancels the wait: the anchor never overrides an
    /// explicit selection.
    #[test]
    fn anchor_wait_cancels_on_the_first_user_move() {
        let mut mode = mode_with_anchor(
            Some("s2"),
            vec![roster_entry("s1", "idle", parent_summary("s1"))],
        );
        mode.handle_key("down");
        assert!(!mode.anchor_selection_pending);
        mode.roster
            .push(roster_entry("s2", "idle", parent_summary("s2")));
        mode.rebuild_rows();
        assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s1");
    }

    /// A nested anchor (a subagent session the user was attached to) arrives
    /// with its ancestors' lists expanded so its row is reachable — the
    /// same expansion the drilled-in return path uses.
    #[test]
    fn nested_anchor_expands_its_ancestors() {
        let mode = mode_with_anchor(
            Some("c"),
            vec![
                roster_entry("p", "idle", parent_summary("p")),
                roster_entry("c", "running", child_summary("c", "p", "worker one")),
            ],
        );
        assert_eq!(mode.rows.len(), 3, "the parent's list opened");
        assert_eq!(mode.rows[mode.selected].summary["sessionId"], "c");
    }

    /// A carried selection (the view/session loop's restore) wins over the
    /// anchor: only fresh opens wait on it.
    #[test]
    fn carried_selection_wins_over_the_entry_anchor() {
        let mut mode = AgentsViewMode::new(AgentsViewOptions {
            socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
            cwd: PathBuf::from("/tmp"),
            session_dir: None,
            theme: "prime".to_string(),
            version: "0.0.0".to_string(),
            anchor_session_id: Some("s2".to_string()),
            scope: None,
            query: None,
            expanded_ancestors: Vec::new(),
            selected_row_identity: None,
            selected_key: Some(crate::agents_view_forest::SelectionKey {
                session_id: Some("s1".to_string()),
                active_session_id: Some("s1-live".to_string()),
            }),
            status_message: None,
            keybindings: crate::keybindings::KeybindingsManager::new(),
        });
        mode.roster = vec![
            roster_entry("s1", "idle", parent_summary("s1")),
            roster_entry("s2", "idle", parent_summary("s2")),
        ];
        mode.rebuild_rows();
        assert_eq!(mode.rows[mode.selected].summary["sessionId"], "s1");
        assert!(!mode.anchor_selection_pending);
    }

    /// The scoped view (the subagents summary line's open action) never
    /// lists the anchor — the scope root is excluded — so the first-row
    /// default stands there.
    #[test]
    fn scoped_view_keeps_the_first_row_default() {
        let mut mode = AgentsViewMode::new(AgentsViewOptions {
            socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
            cwd: PathBuf::from("/tmp"),
            session_dir: None,
            theme: "prime".to_string(),
            version: "0.0.0".to_string(),
            anchor_session_id: Some("p".to_string()),
            scope: Some(AgentsViewScope {
                session_id: Some("p".to_string()),
                active_session_id: Some("p-live".to_string()),
                session_name: Some("p name".to_string()),
            }),
            query: None,
            expanded_ancestors: Vec::new(),
            selected_row_identity: None,
            selected_key: None,
            status_message: None,
            keybindings: crate::keybindings::KeybindingsManager::new(),
        });
        mode.roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "running", child_summary("c", "p", "worker one")),
        ];
        mode.rebuild_rows();
        assert_eq!(mode.rows.len(), 1, "the scope root is excluded");
        assert_eq!(mode.selected, 0);
        assert_eq!(mode.rows[0].summary["sessionId"], "c");
        assert!(mode.anchor_selection_pending, "the wait never resolves");
    }

    /// TS `countRowsBySection` (the splash header counts) counts agent-kind
    /// rows only: a nested running subagent never inflates the header.
    #[test]
    fn header_counts_exclude_nested_rows() {
        let mut mode = mode_with_parent_and_child();
        mode.handle_key("alt+right");
        assert_eq!(mode.rows.len(), 3);
        assert_eq!(mode.rows[2].kind, RowKind::Subagent);
        let (lines, _) = mode.render_frame(120, 36);
        let header = lines
            .iter()
            .map(flat)
            .find(|line| line.contains("running,"))
            .expect("the splash carries the agents count line");
        // The count rides the art line (the splash paints them together):
        // assert the count, not the full line.
        assert!(
            header.contains("agents 0 running, 1 idle, 0 inactive"),
            "header: {header}"
        );
    }

    #[test]
    fn alt_right_toggles_the_subagent_list() {
        let mut mode = mode_with_parent_and_child();
        // Collapsed: the parent, its summary row, nothing else.
        assert_eq!(mode.rows.len(), 2);
        assert_eq!(mode.rows[1].kind, RowKind::SubagentSummary);
        assert!(!mode.rows[1].expanded);
        // alt+right on the parent row (descendantCount > 0) expands.
        mode.handle_key("alt+right");
        assert_eq!(mode.rows.len(), 3);
        assert!(mode.rows[1].expanded);
        assert_eq!(mode.rows[2].kind, RowKind::Subagent);
        assert_eq!(mode.rows[2].depth, 1);
        // alt+right again collapses.
        mode.handle_key("alt+right");
        assert_eq!(mode.rows.len(), 2);
        assert!(!mode.rows[1].expanded);
    }

    /// A mode over the same live parent/child roster whose user bindings
    /// replace keys (TS `keybindings.json` parity, the #184 binding-test
    /// pattern: an override fires, the default goes inert).
    fn mode_with_user_bindings(bindings: &[(&str, &str)]) -> AgentsViewMode {
        let mut cfg = crate::keybindings::KeybindingsConfig::new();
        for (id, key) in bindings {
            cfg.insert(id.to_string(), vec![key.to_string()]);
        }
        let mut mode = AgentsViewMode::new(AgentsViewOptions {
            socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
            cwd: PathBuf::from("/tmp"),
            session_dir: None,
            theme: "prime".to_string(),
            version: "0.0.0".to_string(),
            anchor_session_id: None,
            scope: None,
            query: None,
            expanded_ancestors: Vec::new(),
            selected_row_identity: None,
            selected_key: None,
            status_message: None,
            keybindings: crate::keybindings::KeybindingsManager::with_user_bindings(cfg),
        });
        mode.roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "running", child_summary("c", "p", "worker one")),
        ];
        mode.rebuild_rows();
        mode
    }

    #[test]
    fn open_key_override_fires_and_the_default_is_inert() {
        let mut mode = mode_with_user_bindings(&[("app.agents.open", "ctrl+g")]);
        mode.handle_key("down");
        assert_eq!(mode.rows[mode.selected].kind, RowKind::SubagentSummary);
        // The override fires: the summary row toggles its list.
        mode.handle_key("ctrl+g");
        assert_eq!(mode.rows.len(), 3);
        assert!(mode.rows[1].expanded);
        // The default key no longer opens (a rebound binding replaces the
        // default keys outright).
        mode.handle_key("right");
        assert_eq!(mode.rows.len(), 3, "right is inert after the override");
        assert!(mode.rows[1].expanded);
    }

    #[test]
    fn page_keys_step_by_visible_list_rows() {
        let (mut mode, _) = mode_with_row("paged", "mock-1");
        // 40 extra selectable rows: every step below lands inside the
        // list instead of clamping at an edge.
        let template = mode.rows[0].clone();
        for i in 0..40 {
            let mut row = template.clone();
            row.identity = format!("row-{i}");
            row.title = row.identity.clone();
            row.summary = serde_json::json!({ "sessionName": row.identity.clone() });
            mode.rows.push(row);
        }
        // TS `visibleListRows()` is `max(4, terminal rows - 9)` and the
        // page keys move by `max(1, visibleListRows())`: the terminal
        // height of the last frame sets the step, with the 4-row floor
        // covering short terminals and the pre-render height 0.
        for (height, step) in [(40usize, 31usize), (24, 15), (12, 4), (5, 4), (0, 4)] {
            mode.render_frame(120, height);
            assert_eq!(mode.page_step(), step, "step at terminal height {height}");
            mode.selected = 0;
            mode.handle_key("pageDown");
            assert_eq!(mode.selected, step, "pageDown at terminal height {height}");
            mode.handle_key("pageUp");
            assert_eq!(mode.selected, 0, "pageUp at terminal height {height}");
        }
    }

    #[test]
    fn expand_and_new_key_overrides_fire_and_defaults_are_inert() {
        let mut mode =
            mode_with_user_bindings(&[("app.agents.expand", "alt+x"), ("app.agents.new", "alt+n")]);
        mode.handle_key("alt+x");
        assert_eq!(mode.rows.len(), 3, "the expand override fires");
        mode.handle_key("alt+right");
        assert_eq!(mode.rows.len(), 3, "the default expand key is inert");
        // The new-session override ends the run for a fresh session; the
        // default ctrl+n no longer does.
        mode.handle_key("alt+n");
        assert!(!mode.running);
        assert!(mode.new_session);
        let mut mode =
            mode_with_user_bindings(&[("app.agents.expand", "alt+x"), ("app.agents.new", "alt+n")]);
        mode.handle_key("ctrl+n");
        assert!(mode.running, "the default new key is inert");
        assert!(!mode.new_session);
    }

    #[test]
    fn second_ctrl_c_exits_and_other_keys_clear_the_hint() {
        let mut mode = mode_with_parent_and_child();
        // The first press arms the exit hint (TS `showCtrlCExitHint`).
        mode.handle_key("ctrl+c");
        assert!(mode.exit_armed);
        assert!(mode.running);
        // A second press exits (TS `handleCtrlC`'s visible-hint arm).
        mode.handle_key("ctrl+c");
        assert!(!mode.running);
        // Any other key clears the hint, so the next press re-arms it.
        let mut mode = mode_with_parent_and_child();
        mode.handle_key("ctrl+c");
        mode.handle_key("down");
        assert!(!mode.exit_armed);
        assert!(mode.running);
        mode.handle_key("ctrl+c");
        assert!(mode.exit_armed, "the cleared hint re-arms");
        assert!(mode.running);
    }

    #[test]
    fn exit_hint_renders_the_effective_app_clear_key() {
        let mut mode = mode_with_user_bindings(&[("app.clear", "ctrl+q")]);
        // The rebound key arms the hint, rendered with the override (TS
        // `renderHints`: `Press ${keyText("app.clear")} again to exit`).
        mode.handle_key("ctrl+q");
        assert!(mode.exit_armed);
        assert_eq!(flat(&mode.render_hints(120)), "Press Ctrl+Q again to exit");
        // The default ctrl+c no longer arms the exit flow.
        mode.exit_armed = false;
        mode.handle_key("ctrl+c");
        assert!(!mode.exit_armed);
        assert!(mode.running);
        // Two presses of the override exit (the first re-arms the hint).
        mode.handle_key("ctrl+q");
        assert!(mode.exit_armed);
        mode.handle_key("ctrl+q");
        assert!(!mode.running);
    }

    #[test]
    fn hints_render_the_effective_bindings() {
        // Defaults: TS `renderHints` with the stock keys.
        let mode = mode_with_parent_and_child();
        assert_eq!(
            flat(&mode.render_hints(120)),
            "\u{2191}/\u{2193} navigate   Enter/\u{2192} open   Ctrl+N new"
        );
        // A user override moves the hint with the handler.
        let mode = mode_with_user_bindings(&[("app.agents.new", "ctrl+t")]);
        let hints = flat(&mode.render_hints(120));
        assert_eq!(
            hints,
            "\u{2191}/\u{2193} navigate   Enter/\u{2192} open   Ctrl+T new"
        );
        assert!(!hints.contains("Ctrl+N"), "the default new hint is gone");
    }

    #[test]
    fn enter_toggles_the_summary_row_and_drills_into_a_child() {
        let mut mode = mode_with_parent_and_child();
        // The selection starts on the parent; down lands on the summary
        // row, and Enter toggles it (TS `openSelected` on a summary row).
        mode.handle_key("down");
        assert_eq!(mode.rows[mode.selected].kind, RowKind::SubagentSummary);
        mode.handle_key("enter");
        assert_eq!(mode.rows.len(), 3);
        assert!(mode.rows[1].expanded);
        // Enter on the summary row again collapses.
        mode.handle_key("enter");
        assert_eq!(mode.rows.len(), 2);
        // Expand, walk to the child, drill in (TS `openSelectedSubagent`).
        mode.handle_key("enter");
        mode.handle_key("down");
        assert_eq!(mode.rows[mode.selected].kind, RowKind::Subagent);
        mode.handle_key("enter");
        let opened = mode.opened.as_ref().expect("open recorded");
        assert_eq!(
            opened.selection,
            SessionSelection::Attach("c-live".to_string())
        );
        // The drill-in carries the ancestor chain for the return
        // re-expansion and the child's depth for its tray label.
        assert_eq!(opened.expanded_ancestors, vec!["p".to_string()]);
        assert_eq!(opened.rlm_depth, Some(1));
        // The child itself has no children in this fixture.
        assert!(!opened.has_children);
        assert!(!mode.running);
    }

    #[test]
    fn pending_ancestors_expand_and_selection_restores_after_reentry() {
        // A fresh run carrying the drilled-in child's return state (TS
        // `pendingExpandedAncestorSessionIds` + the persisted selection).
        let mut mode = AgentsViewMode::new(AgentsViewOptions {
            socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
            cwd: PathBuf::from("/tmp"),
            session_dir: None,
            theme: "prime".to_string(),
            version: "0.0.0".to_string(),
            anchor_session_id: None,
            scope: None,
            query: None,
            expanded_ancestors: vec!["p".to_string()],
            selected_row_identity: None,
            selected_key: Some(crate::agents_view_forest::SelectionKey {
                session_id: Some("c".to_string()),
                active_session_id: Some("c-live".to_string()),
            }),
            status_message: None,
            keybindings: crate::keybindings::KeybindingsManager::new(),
        });
        mode.roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "running", child_summary("c", "p", "worker one")),
        ];
        mode.rebuild_rows();
        // The ancestor expansion opened the parent's list and the child
        // row's selection restored.
        assert_eq!(mode.rows.len(), 3);
        assert!(mode.rows[1].expanded);
        assert_eq!(mode.rows[mode.selected].title, "worker one");
    }

    #[test]
    fn scoped_left_returns_the_root_and_pops_the_scope() {
        let mut mode = AgentsViewMode::new(AgentsViewOptions {
            socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
            cwd: PathBuf::from("/tmp"),
            session_dir: None,
            theme: "prime".to_string(),
            version: "0.0.0".to_string(),
            anchor_session_id: None,
            scope: Some(AgentsViewScope {
                session_id: Some("p".to_string()),
                active_session_id: Some("p-live".to_string()),
                session_name: Some("p name".to_string()),
            }),
            query: None,
            expanded_ancestors: Vec::new(),
            selected_row_identity: None,
            selected_key: None,
            status_message: None,
            keybindings: crate::keybindings::KeybindingsManager::new(),
        });
        mode.roster = vec![
            roster_entry("p", "idle", parent_summary("p")),
            roster_entry("c", "running", child_summary("c", "p", "worker one")),
        ];
        mode.rebuild_rows();
        // The scoped view lists the direct child as a top-level row.
        assert!(mode.scope_active);
        assert_eq!(mode.rows.len(), 1);
        assert_eq!(mode.rows[0].kind, RowKind::Agent);
        // The parent key hands the terminal back to the scope root and
        // marks the scope popped for the flow.
        mode.handle_key("left");
        assert!(mode.scope_popped);
        let opened = mode.opened.as_ref().expect("scope-back open");
        assert_eq!(
            opened.selection,
            SessionSelection::Attach("p-live".to_string())
        );
        // The scope root has no ancestors of its own, so nothing
        // re-expands after the return chat.
        assert!(opened.expanded_ancestors.is_empty());
    }

    #[test]
    fn unattachable_child_opens_its_root_with_a_status() {
        let mut mode = mode_with_parent_and_child();
        // A finished child with no runtime and no file resolves to its
        // top-level ancestor (TS `createUnattachableChildOpenResult`).
        let unattachable = serde_json::json!({
            "sessionId": "gc",
            "lifecycle": "live",
            "runtimeKind": "subagent",
            "rlmChildId": "child-gc",
            "rlmDepth": 2,
            "parentActiveSessionId": "c-live",
            "parentSessionId": "c",
            "sessionName": "lost grandchild",
            "messageCount": 1,
        });
        mode.roster
            .push(roster_entry("gc", "inactive", unattachable));
        mode.expanded_parents.insert("file:/x/p.jsonl".to_string());
        mode.rebuild_rows();
        // The child row's identity comes from the roster-qualified id.
        let child_identity = mode
            .rows
            .iter()
            .find(|row| row.title == "worker one")
            .expect("child row renders")
            .identity
            .clone();
        mode.expanded_parents.insert(child_identity);
        mode.rebuild_rows();
        let grandchild = mode
            .rows
            .iter()
            .position(|row| row.title == "lost grandchild")
            .expect("grandchild row renders");
        mode.selected = grandchild;
        mode.handle_key("enter");
        let opened = mode.opened.as_ref().expect("open recorded");
        // The parent chain's root session opens instead, with the child
        // row kept for the selection restore and a status message.
        assert_eq!(
            opened.selection,
            SessionSelection::Attach("p-live".to_string())
        );
        assert_eq!(
            opened.status_message.as_deref(),
            Some("Child session is unavailable; opened its parent instead")
        );
    }
    /// A multi-session roster for the selection-persistence probes: six
    /// idle top-level sessions with distinct activity stamps (newest
    /// first, matching the Idle section's recency sort).
    fn churn_roster() -> Vec<serde_json::Value> {
        (1..=6)
            .map(|n| {
                roster_entry(
                    &format!("s{n}"),
                    "idle",
                    serde_json::json!({
                        "sessionId": format!("s{n}"), "lifecycle": "live",
                        "activeSessionId": format!("s{n}-live"),
                        "sessionFile": format!("/x/s{n}.jsonl"),
                        "runtimeKind": "top-level",
                        "sessionName": format!("session {n}"),
                        "messageCount": 2,
                        "rlmDepth": 0,
                        "lastActivityAt": format!("2025-01-{:02}T00:00:00.000Z", 7 - n),
                    }),
                )
            })
            .collect()
    }

    fn fresh_mode(roster: Vec<serde_json::Value>) -> AgentsViewMode {
        let mut mode = AgentsViewMode::new(AgentsViewOptions {
            socket_path: PathBuf::from("/tmp/agents-view-test.sock"),
            cwd: PathBuf::from("/tmp"),
            session_dir: None,
            theme: "prime".to_string(),
            version: "0.0.0".to_string(),
            anchor_session_id: None,
            scope: None,
            query: None,
            expanded_ancestors: Vec::new(),
            selected_row_identity: None,
            selected_key: None,
            status_message: None,
            keybindings: crate::keybindings::KeybindingsManager::new(),
        });
        mode.roster = roster;
        mode.rebuild_rows();
        mode
    }

    /// Kevin's dogfood symptom (2026-09-21): arrowing down while the
    /// roster churns (subagent spawns, activity re-sorts) must keep the
    /// selection on the same SESSION, and the list window must keep
    /// showing it. The selection is session-keyed (identity, then
    /// active/session id — TS `resolveAgentsViewSelectionState`), so a
    /// rebuild that adds rows ABOVE the selection follows the session
    /// down, and the render window (TS `renderSessionRows`) centers on it
    /// instead of snapping back to the top of the list.
    #[test]
    fn selection_follows_the_session_through_spawn_churn() {
        let roster = churn_roster();
        let mut mode = fresh_mode(roster.clone());
        // Arrow down three times: the selection sits on session 4.
        for _ in 0..3 {
            mode.handle_key("down");
        }
        assert_eq!(mode.rows[mode.selected].title, "session 4");
        // Spawn churn above the selection: session 1 flips to running
        // (moves to the Running section) and a new running child appears
        // under it, both above the selected row's position.
        let mut churned = roster;
        churned[0] = roster_entry(
            "s1",
            "running",
            serde_json::json!({
                "sessionId": "s1", "lifecycle": "live",
                "activeSessionId": "s1-live",
                "sessionFile": "/x/s1.jsonl",
                "runtimeKind": "top-level",
                "sessionName": "session 1",
                "messageCount": 2, "rlmDepth": 0,
                "lastActivityAt": "2025-01-08T00:00:00.000Z",
            }),
        );
        churned.push(roster_entry(
            "/x/s1.jsonl#child-w",
            "running",
            child_summary("w", "s1", "spawned worker"),
        ));
        mode.apply_roster_update(churned.clone(), Vec::new(), false);
        // The selection follows session 4's identity, not the row index.
        assert_eq!(
            mode.rows[mode.selected].title, "session 4",
            "spawn churn must not move the selection off the selected session"
        );
        // The selected session stays selectable and its key stays synced
        // (TS `syncSelectedRowState`): further churn keeps following it.
        for _ in 0..3 {
            mode.apply_roster_update(churned.clone(), Vec::new(), false);
        }
        assert_eq!(mode.rows[mode.selected].title, "session 4");
    }

    /// TS parity: an idle roster re-push (same sessions, same states) is a
    /// no-op — the rebuild must not touch the selection at all (same row,
    /// same index, same identity).
    #[test]
    fn selection_untouched_by_noop_roster_updates() {
        let roster = churn_roster();
        let mut mode = fresh_mode(roster.clone());
        for _ in 0..3 {
            mode.handle_key("down");
        }
        let (index, identity, key) = (
            mode.selected,
            mode.rows[mode.selected].identity.clone(),
            mode.selected_key.clone(),
        );
        // The daemon re-pushes identical entries (idle status ticks).
        mode.apply_roster_update(roster, Vec::new(), false);
        assert_eq!(mode.selected, index);
        assert_eq!(mode.rows[mode.selected].identity, identity);
        assert_eq!(mode.selected_key, key);
    }

    /// The selected session left the roster (archived away, no saved-catalog
    /// row for it): the resolution cannot re-find it, and TS
    /// `resolveAgentsViewSelectionState` keeps the bounded current index —
    /// never a reset to the top of the list.
    #[test]
    fn selected_session_gone_keeps_the_bounded_position() {
        let roster = churn_roster();
        let mut mode = fresh_mode(roster.clone());
        for _ in 0..3 {
            mode.handle_key("down");
        }
        assert_eq!(mode.rows[mode.selected].title, "session 4");
        let shrunk: Vec<serde_json::Value> = roster
            .into_iter()
            .filter(|entry| entry["agentId"] != serde_json::json!("s4"))
            .collect();
        mode.apply_roster_update(Vec::new(), vec!["s4".to_string()], false);
        assert_eq!(mode.roster.len(), shrunk.len());
        // The identity and its keys are gone: the selection keeps the
        // bounded index (the row that now occupies the slot), not 0.
        assert_eq!(mode.selected, 3);
        assert_eq!(mode.rows[mode.selected].title, "session 5");
    }

    /// TS `renderSessionRows` viewport parity: the list window centers on
    /// the selected row and clips the overflow behind ellipsis lines, so
    /// arrowing below the fold keeps the selection visible — the Rust view
    /// used to render from the top and truncate, which read as the
    /// selection teleporting back up while the roster churned.
    #[test]
    fn list_window_follows_the_selection_below_the_fold() {
        let roster: Vec<serde_json::Value> = (1..=12)
            .map(|n| {
                roster_entry(
                    &format!("s{n}"),
                    "idle",
                    serde_json::json!({
                        "sessionId": format!("s{n}"), "lifecycle": "live",
                        "activeSessionId": format!("s{n}-live"),
                        "sessionFile": format!("/x/s{n}.jsonl"),
                        "runtimeKind": "top-level",
                        "sessionName": format!("session {n}"),
                        "messageCount": 2, "rlmDepth": 0,
                        "lastActivityAt": format!("2025-01-{:02}T00:00:00.000Z", 13 - n),
                    }),
                )
            })
            .collect();
        let mut mode = fresh_mode(roster);
        assert_eq!(mode.rows.len(), 12);
        let frame_texts = |mode: &mut AgentsViewMode| -> Vec<String> {
            mode.render_list(120, 8)
                .iter()
                .map(|line| line.iter().map(|span| span.content.as_str()).collect())
                .collect()
        };
        // Selection at the top: legend + spacer + heading + four rows +
        // the trailing ellipsis — 8 lines, the first four sessions below
        // the fold clipped away (TS `renderSessionRows` with maxRows 8:
        // headerRows 2, visibleRows 6, one trailing clip row).
        let texts = frame_texts(&mut mode);
        assert_eq!(texts.len(), 8);
        assert!(texts[0].contains("Session"), "legend: {texts:?}");
        assert!(texts[2].contains("Idle (12)"));
        assert!(texts[3].contains("session 1"));
        assert_eq!(texts[7].trim(), "...");
        assert!(!texts.iter().any(|t| t.contains("session 5")));
        // Arrow to the bottom: the window centers on the selected row
        // (session 12 stays on-screen), the leading ellipsis covers the
        // clipped rows above, and the trailing one disappears at the end.
        for _ in 0..11 {
            mode.handle_key("down");
        }
        assert_eq!(mode.rows[mode.selected].title, "session 12");
        let texts = frame_texts(&mut mode);
        assert_eq!(texts.len(), 8);
        assert_eq!(texts[2].trim(), "...");
        assert!(
            texts.iter().any(|t| t.contains("session 12")),
            "the selected row must render inside the window: {texts:?}"
        );
        assert!(!texts.iter().any(|t| t.contains("session 7")));
        assert_ne!(texts.last().map(|t| t.trim()), Some("..."));
        // The selected row carries the selection background (its line
        // paints over the full width; the unselected rows do not).
        let selected_line = mode.render_list(120, 8);
        let painted = selected_line
            .iter()
            .any(|line| line.iter().any(|span| span.style.bg.is_some()));
        assert!(
            painted,
            "the selected row renders with the selection background"
        );
        // Arrow back to the top: the leading ellipsis goes away and the
        // first rows render behind the legend again.
        for _ in 0..11 {
            mode.handle_key("up");
        }
        assert_eq!(mode.rows[mode.selected].title, "session 1");
        let texts = frame_texts(&mut mode);
        assert!(texts[3].contains("session 1"));
        assert_eq!(texts[7].trim(), "...");
    }
}
