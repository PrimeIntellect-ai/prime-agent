//! The agents view: the unified live-roster + saved-catalog session list
//! (TS `AgentsViewMode`). Rows group into Running/Idle/Inactive sections,
//! the inline prompt doubles as search, and the first actions are open
//! (attach a live session) and resume (reopen a saved file); `n` starts a
//! new session. Roster pushes arrive live over `roster_subscribe`; the
//! saved catalog loads once on open (TS parity: it feeds the Inactive
//! section). The reply composer waits on the Stage-3 reply machinery.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
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
use crate::theme::{Theme, ThemeColor};
use crate::width::{pad_line, str_width};
use crate::Line;
mod data_input;

mod open_incident;

mod render;
#[cfg(test)]
use render::cell;
use render::Renderer;

mod delete;

#[cfg(test)]
use delete::no_effect_summary;
use delete::{spawn_delete_dispatch, DeleteAction, PendingDelete};

mod rename;
use rename::{spawn_rename_dispatch, Rename};

mod reply;
use reply::{
    spawn_headline_fetch, spawn_kill_dispatch, spawn_reply_dispatch, KillRequest, ReplyRequest,
};

mod status;
use status::{Status, StatusTone};

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
    /// The `showHardwareCursor` setting snapshot the view mounts with (TS
    /// `AgentsViewMode` constructs its TUI with
    /// `settingsManager.getShowHardwareCursor()`, default false): the
    /// hardware cursor is positioned at the search caret for IME every
    /// frame, but only shown when this is set.
    pub show_hardware_cursor: bool,
    /// The incident notice state carried across view runs (TS
    /// `AgentsViewPersistentState.incidentNoticeState`): the windowed log
    /// entries, the consumed log offset, and the dismissal horizons
    /// survive leaving and re-entering the view, so a dismissed incident
    /// never comes back and the poll does not re-read consumed bytes.
    /// `None` on the first run creates a fresh state.
    pub incident_notice_state: Option<crate::incident_notices::IncidentNoticeState>,
    /// The flow's own `create` config (TS `AgentsViewModeOptions.config`):
    /// the base a saved reply's resume derives its config from (the
    /// view's runtime config with the session's own cwd removed, or the
    /// view's cwd when the saved directory no longer exists).
    pub create_config: serde_json::Value,
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
    /// The opened session's own directory (the roster summary's `cwd`):
    /// the session run rides it as its cwd (the completion base and the
    /// session chrome browse the attached session's directory, not the
    /// view's launch directory — TS `getCurrentCwd`).
    pub cwd: Option<String>,
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
    /// Hold until a frame rendered after this step contains `needle`
    /// (bounded by `timeout_ms`): the condition wait for daemon-driven
    /// rows (the saved catalog's rows), which arrive on the event
    /// cadence rather than a known wall-clock delay.
    WaitRender { needle: String, timeout_ms: u64 },
    /// A plain left click on one screen cell (zero-based): the verifier
    /// drives the click grammar with the same SGR press/release pair a
    /// terminal sends.
    Click { row: usize, col: usize },
    /// A raw SGR mouse sequence, decoded by the same parser the
    /// terminal's reports flow through (the drag report between a
    /// click's press and release).
    Mouse(String),
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
    /// The scoped panel handed the pane back to its scope root's chat
    /// (the parent key with pop, escape without — TS `scope_back` in
    /// both arms): the reopened chat starts with the dock focused on the
    /// panel's own group (the Subagents item), not the prompt bar.
    pub scope_back: bool,
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
    /// The opened session's own directory (the roster summary's `cwd`):
    /// the session run rides it as its cwd so the completion base and the
    /// chrome browse the attached session's directory, not the launch
    /// directory (TS `getCurrentCwd`).
    pub opened_cwd: Option<std::path::PathBuf>,
    /// A status message the session opener left (TS
    /// `statusMessage` on the open result): the unattachable-child
    /// fallback surfaces it in the next view run.
    pub status_message: Option<String>,
    /// The view actions this run performed (`program_shown`, when a
    /// ctrl+o turned a spawn program on; `renamed`, when a rename
    /// landed): the composition root emits the `tui agents action`
    /// adoption events at the run's end.
    pub actions: Vec<&'static str>,
    /// The incident notice state this run ended with, for the caller to
    /// restore on re-entry (TS `persistentState.incidentNoticeState`):
    /// dismissal horizons and the consumed log offset survive.
    pub incident_notice_state: crate::incident_notices::IncidentNoticeState,
}

/// TS `WORKING_ICON_INTERVAL_MS`: the running-row icon frame cadence.
const PULSE_INTERVAL_MS: u64 = 250;

/// The saved-catalog stream's batch window (TS
/// `SAVED_CATALOG_RECONCILE_INTERVAL_MS`): streamed rows reconcile into
/// the view on this cadence, so a continuous scan still appears
/// progressively without a rebuild per row.
const SAVED_CATALOG_RECONCILE_INTERVAL_MS: u64 = 75;

/// The transient status hint while the entry anchor still waits on its
/// row (see [`AgentsViewMode::open_selected`]); dropped once the anchor
/// lands.
const ANCHOR_LOADING_HINT: &str = "Still loading sessions — press ↓ or ↑ to pick a session now.";

/// The saved-catalog fetch's request budget: the LONG-RUNNING class, never
/// the 30s default. The scan is the known-slow whole-file re-parse of every
/// saved session (the operator's ~130-session dir takes over a minute), so
/// the default class turned every large dir into a false `Saved sessions
/// unavailable` timeout — the loading state that never completes. The
/// scan-state-cache lane owns the scan's speed; this is the lifecycle's
/// budget so the state can complete at all.
fn saved_catalog_timeout_ms() -> u64 {
    crate::daemon_client::LONG_RUNNING_REQUEST_TIMEOUT_MS
}

enum UiInput {
    Key(String),
    /// One paste (bracketed, or the paste-aware reader's coalesced
    /// marker-less burst): the armed composer's editor takes it; the
    /// search field ignores it.
    Paste(String),
    /// The headless plan's `WaitRender` barrier: the loop holds the
    /// queued plan batch behind it until a frame rendered after arming
    /// contains the needle (the interactive harness's condition-wait
    /// contract, view-scoped).
    WaitRender {
        needle: String,
        timeout_ms: u64,
    },
    /// A decoded SGR mouse report (the click grammar's input).
    Mouse(crate::mouse::MouseEvent),
    Resize,
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
    /// One stop-or-delete dispatch landed (the ctrl+x flow): the status
    /// line reports the outcome in the tone the dispatch classified it
    /// with (success muted, a no-effect stop warning, a failure error).
    DeleteResult {
        message: String,
        tone: StatusTone,
        /// The deleted saved session's path (the catalog key for the
        /// immediate row removal); `None` for the other arms.
        deleted_saved_path: Option<String>,
    },
    /// One rename dispatch landed (the ctrl+r flow): the status line
    /// reports the outcome and a saved target's row patches in place.
    RenameResult {
        rename: Rename,
        outcome: Result<(), String>,
    },
    /// The armed target's last-assistant headline landed (or failed):
    /// the header renders it; a re-targeted or disarmed composer drops
    /// it.
    HeadlineResult {
        key: String,
        result: Result<Option<String>, String>,
    },
    /// The saved-resume path's mid-send status (TS `sendReply`: the
    /// "Sending reply..." after "Resuming session..." — the loop paints
    /// each as it lands, never both at once).
    ReplyProgress(String),
    /// One reply send landed: the resumed summary and the sticky cwd
    /// notice on success, the wire's error on failure.
    ReplyResult {
        key: String,
        outcome: Result<reply::ReplySent, String>,
    },
    /// One `/kill` view-command dispatch landed.
    KillResult {
        key: String,
        outcome: Result<(), String>,
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
    /// The saved catalog the flow's previous view run loaded (TS
    /// `AgentsViewPersistentState.savedSessions` + `savedCatalogLoaded`):
    /// a re-entry paints the Inactive rows it already holds on its FIRST
    /// frame instead of rebuilding the section from empty behind a fresh
    /// scan, and a loaded catalog skips the re-fetch entirely (TS
    /// `armSavedSearchFetch`'s early return). The chat handoff parks this
    /// link; the next run seeds from it and writes its own final state
    /// back for the run after that.
    saved_sessions: Vec<Value>,
    saved_catalog_loaded: bool,
}

impl AgentsViewLink {
    async fn connect(socket_path: &std::path::Path) -> Result<Self> {
        let (client, events) = DaemonClient::connect_with_retry(socket_path).await?;
        Ok(Self {
            client,
            events,
            saved_sessions: Vec::new(),
            saved_catalog_loaded: false,
        })
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

/// One end of the selectable rows: the `home`/`end` list jumps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionEdge {
    First,
    Last,
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
    /// The status line (TS `statusMessage` + `statusMessageTone` + the
    /// 4.5s timer): rendered at the bottom hint row in its tone, expired
    /// by the loop's deadline arm, sticky lines cleared by the next key.
    status: Option<Status>,
    /// A multi-line notice from the previous run (a daemon refusal whose
    /// ways out span lines, like the cross-product lease hold): rendered
    /// as a dismissible panel above the hint line instead of the one-line
    /// status truncation, so the full text — both ways out included —
    /// stays readable.
    notice: Option<String>,
    /// The armed stop-or-delete confirm (TS `pendingDeleteAgent` /
    /// `pendingKillSubagent`, keyed by row identity): the first ctrl+x
    /// arms it over the selected row, the second press on the same row
    /// executes, any other key clears it.
    pending_delete: Option<PendingDelete>,
    /// The prompt's composition state (TS the editor's composer modes):
    /// the search field, or the rename composer while a rename composes.
    composer: Composer,
    /// The confirmed rename the run loop dispatches (the rename flow's
    /// `pending_delete_action` shape: the wire call runs off the key
    /// loop with the client).
    pending_rename: Option<Rename>,
    /// The submitted reply the run loop dispatches (the reply flow's
    /// same shape): the send runs off the key loop with the client, and
    /// its keyed outcome re-enters as a `ReplyResult`.
    pending_reply: Option<ReplyRequest>,
    /// One `/kill` view command the run loop dispatches (the reply
    /// flow's shape): the keyed outcome re-enters as a `KillResult`.
    pending_kill: Option<KillRequest>,
    /// The armed target whose headline fetch runs (its key and active
    /// id): the loop dispatches the fetch, detached — its keyed result
    /// drops when the composer is gone or re-targeted.
    pending_headline: Option<(String, String)>,
    /// The executed delete the run loop takes (the dispatch runs off the
    /// key loop with the client, the saved-catalog fetch's pattern).
    pending_delete_action: Option<DeleteAction>,
    /// Session paths deleted this run: an in-flight saved-catalog
    /// response can still carry a file the daemon already deleted, so
    /// the catalog apply filters these paths out (a deleted row never
    /// reappears behind a slow fetch).
    deleted_saved_paths: std::collections::HashSet<String>,
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
    /// Parent row identities whose subagents lines are expanded (TS
    /// `expandedSubagentParents`): the one summary line per parent
    /// reads a single set.
    expanded_parents: std::collections::HashSet<String>,
    /// Parent row identities whose spawn programs render inside their
    /// open list (TS `programShownParents`). Like `expanded_parents`,
    /// it never carries across view runs (a shown program without its
    /// expansion is meaningless — TS persists both, an inherited
    /// divergence).
    program_shown_parents: std::collections::HashSet<String>,
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
    /// The scoped panel handed the pane back to its scope root's chat
    /// (the parent key with pop, escape without): the reopened chat
    /// restores the dock focus on the panel's own group instead of the
    /// prompt bar.
    scope_back: bool,
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
    /// The saved-catalog fetch settled on a terminal failure: the entry
    /// anchor's wait ended with it, and the next query change re-arms one
    /// retry (TS `rearmSavedSearchFetch`).
    saved_fetch_failed: bool,
    /// The incident notice state (TS `persistentState.incidentNoticeState`
    /// — `??=` lazily initialized on first access, materialized here):
    /// windowed log entries, the consumed log offset, dismissal horizons,
    /// and the collapsed notice line.
    incident_notice_state: crate::incident_notices::IncidentNoticeState,
    /// A failed saved-catalog fetch wants re-arming on the query's next
    /// change (the loop owns the client, so the mode records the intent).
    saved_query_rearm: bool,
    /// The saved catalog's streamed rows waiting for the batch window
    /// (TS `refreshSavedSessions`'s `onSession` progressive map): the
    /// daemon streams `session_list_item` frames newest-first while the
    /// scan runs, the loop buffers the live fetch's frames, and one
    /// rebuild flushes the batch - the entry anchor's row lands long
    /// before the scan's final response, so a dead continue-target is
    /// selectable within the first window instead of the whole scan
    /// (the operator's `Still loading sessions` hold).
    saved_stream: Vec<Value>,
    /// The catalog settled on a successful load (TS
    /// `AgentsViewPersistentState.savedCatalogLoaded`): the run arms no
    /// fetch while it holds, and the exit link carries it so the flow's
    /// next view run skips its own fetch.
    saved_catalog_loaded: bool,
    /// The screen rows of the rendered session rows, in frame order: a
    /// plain left click selects and opens the row under it (the Enter
    /// action), so the recorded span is exactly the rows the last frame
    /// painted. Rebuilt on every render; empty while no row is visible.
    click_rows: Vec<(usize, usize)>,
    /// The frame row under the mouse (the hover affordance, operator
    /// directive 2026-09-29): a row that resolves against the last
    /// frame's click surface, `None` over anything else. Revalidated
    /// against each render's click rows, so content that moves under
    /// the mouse re-aims the band and a row that scrolled away clears
    /// it.
    hover_row: Option<usize>,
    /// The left press a release may fire (TS's press/release click
    /// grammar): the pressed row and whether the press turned into a
    /// drag — a dragged release never opens.
    pressed_click: Option<PressedMouseClick>,
    /// The view actions this run performed (reported on the outcome so
    /// the composition root emits the adoption events at the run's
    /// end — the view owns no telemetry handle): `program_shown`,
    /// `renamed`.
    actions: Vec<&'static str>,
}

/// The press state of one left click on the agents view (TS
/// `fullscreenPressedClick`'s grammar, row-scoped: the release must land
/// on the same row).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PressedMouseClick {
    row: usize,
    dragged: bool,
}

/// The prompt's composition state (TS the editor's composer modes): the
/// plain search field, or one action's composer that owns the prompt
/// and the key routing. Each composer owns its [`Editor`] — the text,
/// the provider, and the history can never leak between modes, and an
/// editor while searching cannot be represented. [`Box`] keeps the
/// variant against the unit `Search` under clippy's large-enum-variant.
enum Composer {
    Search,
    Rename(Box<rename::RenameComposer>),
    Reply(Box<reply::ReplyComposer>),
}

impl AgentsViewMode {
    fn new(mut options: AgentsViewOptions) -> Self {
        let theme = crate::app::load_theme(&options.theme);
        let query = options.query.clone().unwrap_or_default();
        // A notice with lines to show (the refusal families) renders as
        // the dismissible panel; a single-line notice keeps the hint-line
        // status.
        let (status, notice) = match options.status_message.clone() {
            Some(message) if message.contains('\n') => (None, Some(message)),
            // TS seeds the run's status with the carried line through
            // `setStatusMessage` (the default tone rule and the timer
            // apply to it, exactly like any later line).
            status => (status.as_deref().map(Status::transient), None),
        };
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
        // TS `persistentState.incidentNoticeState ??= createIncidentNoticeState()`:
        // the first run starts fresh; later runs continue the carried state.
        let incident_notice_state = options.incident_notice_state.take().unwrap_or_default();
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
            notice,
            pending_delete: None,
            composer: Composer::Search,
            pending_rename: None,
            pending_reply: None,
            pending_kill: None,
            pending_headline: None,
            pending_delete_action: None,
            deleted_saved_paths: std::collections::HashSet::default(),
            scope_depth: None,
            scope_active: false,
            scope_dropped: false,
            expanded_parents: std::collections::HashSet::default(),
            program_shown_parents: std::collections::HashSet::default(),
            pending_ancestors,
            selected_identity,
            selected_key,
            anchor_selection_pending,
            exit_armed: false,
            exit_guard: crate::exit_guard::ExitGuard::new(),
            pulse: 0,
            running: true,
            scope_popped: false,
            scope_back: false,
            opened: None,
            new_session: false,
            saved_fetch_failed: false,
            saved_query_rearm: false,
            saved_stream: Vec::new(),
            saved_catalog_loaded: false,
            incident_notice_state,
            click_rows: Vec::new(),
            hover_row: None,
            pressed_click: None,
            actions: Vec::new(),
        }
    }
}

/// Run the agents view until the user exits or opens a session.
/// Open the roster connection and pull the first snapshot (TS
/// `AgentsViewRosterStore` connect plus the `roster_subscribe`
/// round-trip). The flow's parked connection comes first (TS
/// `persistentState.rosterClient` staying connected across the loop); a
/// fresh run connects its own, and a parked connection that died (daemon
/// update) reconnects once. The roster snapshot precedes streaming
/// pushes; updates that race the snapshot apply on top (idempotent by
/// agent id, TS roster-store). Errors leave any opened connection closed.
async fn open_roster_link(
    options: &AgentsViewOptions,
    link: Option<AgentsViewLink>,
) -> Result<(
    DaemonClient,
    mpsc::UnboundedReceiver<DaemonClientEvent>,
    Vec<Value>,
    Vec<Value>,
    bool,
)> {
    let (mut client, mut events, saved_sessions, saved_catalog_loaded) =
        if let Some(AgentsViewLink {
            client,
            events,
            saved_sessions,
            saved_catalog_loaded,
        }) = link
        {
            (client, events, saved_sessions, saved_catalog_loaded)
        } else {
            let link = AgentsViewLink::connect(&options.socket_path)
                .await
                .with_context(|| "the agents view could not attach to the daemon")?;
            (
                link.client,
                link.events,
                link.saved_sessions,
                link.saved_catalog_loaded,
            )
        };
    let roster_subscribe = || DaemonCommand::RosterSubscribe {
        id: None,
        rest: serde_json::Map::default(),
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
    let roster = snapshot
        .data
        .as_ref()
        .and_then(|data| data.get("roster"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok((client, events, roster, saved_sessions, saved_catalog_loaded))
}

/// The saved-catalog fetch (TS `armSavedSearchFetch`): one request whose
/// result (or failure) re-enters the loop as a `UiInput`, while the scan's
/// `session_list_item` stream re-enters as events under the fetch's own
/// request id — the id the loop compares against (TS's connection routes
/// the stream to the originating `listDaemonSavedSessions` callbacks). The
/// scan is the known-slow path — the whole-file re-parse of every saved
/// session — so it rides the LONG-RUNNING request budget: the default 30s
/// class would turn every large sessions dir into a false
/// `Saved sessions unavailable` and leave the entry anchor's row
/// permanently unloaded (the loading state that outlives the scan). A
/// terminal failure re-arms on the next query change (the loop's
/// `take_saved_fetch_rearm`), like TS `rearmSavedSearchFetch`.
fn spawn_saved_catalog_fetch(
    client: &DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    cwd: PathBuf,
    session_dir: Option<PathBuf>,
) -> String {
    static CATALOG_FETCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let client = client.clone();
    // The id rides the supervisor reader's `daemon_` namespace: the
    // socket-close failure pass (`fail_pending("daemon_", ..)`) must cover
    // the fetch too, or a dead connection leaves the long-running scan's
    // oneshot armed until its whole budget (the exit-hang class of bugs).
    let id = format!(
        "daemon_catalog-{}",
        CATALOG_FETCH_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1
    );
    let request_id = id.clone();
    tokio::spawn(async move {
        let saved = client
            .request_supervisor_with_id(
                DaemonCommand::ListSavedSessions {
                    id: None,
                    cwd: Some(cwd.to_string_lossy().to_string()),
                    session_dir: session_dir.map(|dir| dir.to_string_lossy().to_string()),
                    active_session_id: None,
                    scope: Value::Null,
                    rest: serde_json::Map::default(),
                },
                &request_id,
                saved_catalog_timeout_ms(),
            )
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
    id
}

/// Run the agents view over the roster link (terminal or headless) and
/// return its run state.
///
/// # Errors
///
/// Returns `Err` when the view surface fails (a roster-link failure,
/// a draw failure, a transport error); a terminal-mode error runs the
/// exit restore first when this run mounted the surface or adopted a
/// pane already in TUI state.
pub async fn run_agents_view(
    options: AgentsViewOptions,
    ui: AgentsViewUiMode,
    link: Option<AgentsViewLink>,
) -> Result<AgentsViewRun> {
    // Every error return funnels through the one exit restore (an early
    // `?` between the surface mount and the tail teardown must not hand
    // the shell a terminal still in TUI state); the restore is
    // idempotent, so the failed-roster release below costing a second
    // pass only re-emits the two unconditional tail bytes. The headless
    // view never owned the terminal, and a terminal-mode error that fired
    // before this surface mounted must not tear down whatever the caller
    // had up (the roster-link failure runs its own release inside the
    // surface fn when the pane was handed over already in TUI state).
    let owns_terminal = matches!(ui, AgentsViewUiMode::Terminal);
    let surface_mounted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mounted = std::sync::Arc::clone(&surface_mounted);
    match run_agents_view_surface(options, ui, link, mounted).await {
        Ok(run) => Ok(run),
        Err(error) => {
            // Same rule as the session surface: restore when this run
            // changed the terminal state (the flag arms at the raw-mode
            // entry) OR when it entered on a pane already in TUI state
            // (the preserve handoff it must release even on a pre-mount
            // failure).
            if owns_terminal
                && (surface_mounted.load(std::sync::atomic::Ordering::SeqCst)
                    || crate::altscreen::active())
            {
                crate::exit_restore::restore_terminal();
            }
            Err(error)
        }
    }
}

async fn run_agents_view_surface(
    options: AgentsViewOptions,
    ui: AgentsViewUiMode,
    link: Option<AgentsViewLink>,
    surface_mounted: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<AgentsViewRun> {
    crossterm::style::force_color_output(true);
    // The connection and its first snapshot precede every surface state:
    // this pane was handed over already in TUI state (raw mode on, the
    // alternate screen up, the cursor hidden — the chat's teardown
    // preserves them for this view), so a failure here must hand the
    // terminal back before the error escapes (TS `returnToAgentsView`'s
    // `finally` runs the same release on a failed handoff); nothing below
    // runs to do it.
    let (client, mut events, roster, saved_sessions, saved_catalog_loaded) =
        match open_roster_link(&options, link).await {
            Ok(open) => open,
            Err(error) => {
                if matches!(ui, AgentsViewUiMode::Terminal) {
                    crate::exit_restore::restore_terminal();
                }
                return Err(error);
            }
        };

    // The double-Ctrl+C force-quit guard: same contract as the session
    // loop (see `interactive::run_interactive`).
    let exit_guard = crate::exit_guard::ExitGuard::new();
    let mut mode = AgentsViewMode::new(options.clone());
    mode.exit_guard = exit_guard.clone();

    mode.roster = roster;
    // The flow's carried catalog paints on the FIRST frame (TS
    // `persistentState.savedSessions` seeding the mode): a re-entry's
    // Inactive section never rebuilds from empty, and a loaded catalog
    // means no fetch at all below.
    mode.saved = saved_sessions;
    mode.saved_catalog_loaded = saved_catalog_loaded;
    mode.rebuild_rows();
    // TS `start()`'s `this.refreshIncidentNotices()`: the notice from the
    // log's bounded tail paints on the FIRST frame, before the 30s
    // interval's first tick.
    mode.refresh_incident_notices();

    let (ui_tx, mut ui_rx) = mpsc::unbounded_channel::<UiInput>();
    // A panic anywhere between the mount below and the deliberate
    // teardown must still hand the terminal back whole (the same
    // unwind-guard contract the session surface arms).
    let _surface_restore = crate::exit_restore::SurfaceRestore::armed();
    let mut renderer = Renderer::setup(
        ui,
        ui_tx.clone(),
        exit_guard.clone(),
        &surface_mounted,
        options.show_hardware_cursor,
    )?;
    // The first frame renders from the live roster the moment the surface
    // mounts (TS `applySessionList(this.rosterStore.summaries(), true)`
    // before its first `requestRender`): the saved-catalog fetch below
    // applies as an input when it lands instead of holding the frame.
    renderer.draw(&mut mode);
    // The saved catalog feeds the Inactive section (cwd + sessionDir
    // scope). TS `armSavedSearchFetch` runs the scan while the view is
    // already interactive, so a large catalog never delays the first
    // frame; the result (or its failure) re-enters the loop as an input.
    // The loop's re-arm closure shares these clones (the mode holds the
    // row state, never the client).
    let cwd = mode.options.cwd.clone();
    let session_dir = mode.options.session_dir.clone();
    // Broadcast frames that landed on the parked connection while the view
    // was closed (heartbeats): the fresh roster snapshot supersedes them.
    // The drain runs BEFORE the catalog fetch spawns - the fetch's
    // `session_list_item` stream is live data now, and a drain after the
    // spawn could discard its first frames (the entry anchor's row rides
    // the scan's newest-first head, exactly the rows the wait needs
    // soonest).
    while events.try_recv().is_ok() {}
    // TS `armSavedSearchFetch`'s early return: a loaded catalog never
    // re-fetches (the flow's own runs share one link; the delete flow
    // removes its row by path). A first run - or one whose previous fetch
    // failed - arms the one fetch whose stream and result re-enter the
    // loop below.
    let mut catalog_request = (!mode.saved_catalog_loaded).then(|| {
        spawn_saved_catalog_fetch(&client, ui_tx.clone(), cwd.clone(), session_dir.clone())
    });
    // TS `start()`'s open-time settle (`armSavedSearchFetch` followed by
    // `resolveMissingSelectionAnchor`): a carried catalog arms no fetch,
    // so no terminal load ever arrives to settle the entry anchor's wait -
    // resolve it now. The anchor's row either landed from the carry's
    // rebuild above or the catalog already settled without it; an armed
    // fetch keeps the wait (its load settles it).
    if catalog_request.is_none() {
        mode.end_anchor_wait();
    }
    let mut pending: Vec<UiInput> = Vec::new();
    let mut last_pulse = tokio::time::Instant::now();
    // TS `setInterval(refreshIncidentNotices, INCIDENT_NOTICE_POLL_INTERVAL_MS)`:
    // the re-read of appended agent.jsonl bytes, re-derived and re-rendered
    // only when the collapsed line changed (`.unref()` — it never keeps the
    // app alive; here the deadline simply stops firing with the loop).
    let mut incident_poll_at = tokio::time::Instant::now()
        + Duration::from_millis(crate::incident_notices::INCIDENT_NOTICE_POLL_INTERVAL_MS);
    // The saved-catalog stream's open batch window: the first buffered row
    // arms it, the flush closes it (TS `refreshSavedSessions`'s
    // `savedCatalogReconcileTimer`).
    let mut saved_flush: Option<tokio::time::Instant> = None;
    // In-flight delete/rename dispatches; teardown waits for them so an exit
    // right after a confirmed action does not drop the request.
    let mut action_dispatches: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    // The headless plan's render barrier (`AgentsStep::WaitRender`, the
    // interactive harness's condition-wait contract): an armed hold's
    // deadline, and the frames captured at arming (the condition scans
    // only frames rendered after the barrier reached the queue head, so
    // a needle that already scrolled out of an older frame still
    // satisfies it — except the newest frame at arming time, which pops
    // immediately instead of stalling on a repaint that may never
    // come).
    let mut wait_render_deadline: Option<tokio::time::Instant> = None;
    let mut wait_render_baseline: usize = 0;

    while mode.running {
        let mut redraw = false;
        // The headless plan's render barrier: `WaitRender` holds the
        // queued PLAN batch behind it until a frame rendered after
        // arming contains the needle — daemon-driven rows (the saved
        // catalog's rows) land on the event cadence rather than a known
        // wall-clock delay, so the condition wait rides out any load
        // latency where a fixed sleep only wins on an idle machine. The
        // daemon-driven answers jump the hold (the promotion below):
        // the catalog's landing is the very event the needle waits on,
        // so queueing it behind the barrier would wedge the wait on its
        // own condition. The barrier sits at the queue head until it
        // pops, so `first_input` below never sees it.
        let mut barrier_holds = false;
        if wait_render_deadline.is_some() {
            if let Some(index) = pending.iter().position(is_daemon_answer) {
                let input = pending.remove(index);
                pending.insert(0, input);
            }
        }
        while let Some(UiInput::WaitRender { needle, timeout_ms }) = pending.first() {
            let needle = needle.clone();
            let timeout_ms = *timeout_ms;
            let frames = renderer.headless_frames();
            if let Some(deadline) = wait_render_deadline {
                let satisfied = frames.is_some_and(|frames| {
                    frames
                        .get(wait_render_baseline..)
                        .unwrap_or_default()
                        .iter()
                        .any(|frame| frame.contains(&needle))
                });
                if satisfied {
                    wait_render_deadline = None;
                    pending.remove(0);
                    continue;
                }
                if tokio::time::Instant::now() > deadline {
                    wait_render_deadline = None;
                    pending.remove(0);
                    // The hold's honest failure bound: the deadline
                    // pops it and the plan proceeds; the status note
                    // reports the wait that never satisfied (never the
                    // needle itself — the note renders into frames, and
                    // quoting the needle would satisfy the very
                    // condition that failed).
                    mode.set_status("timed out waiting for the headless render condition");
                    redraw = true;
                    continue;
                }
            } else {
                let holds_now = frames.is_some_and(|frames| {
                    frames.last().is_some_and(|frame| frame.contains(&needle))
                });
                if holds_now {
                    pending.remove(0);
                    continue;
                }
                wait_render_baseline = frames.map_or(0, <[String]>::len);
                wait_render_deadline =
                    Some(tokio::time::Instant::now() + Duration::from_millis(timeout_ms));
            }
            barrier_holds = true;
            break;
        }
        let popped = if barrier_holds {
            None
        } else {
            first_input(&mut pending)
        };
        if let Some(input) = popped {
            match input {
                UiInput::Key(key) => {
                    mode.handle_key(&key);
                    // The composer's parked suggestion request
                    // materializes once the key's edits landed (TS's
                    // editor materializes after the keystroke batch).
                    mode.materialize_composer_autocomplete();
                    // TS `queryChanged` -> `armSavedSearchFetch`: a failed
                    // saved-catalog fetch re-arms on the next query change,
                    // so the Inactive section gets one honest retry behind
                    // a terminal failure instead of staying empty for the
                    // rest of the run.
                    if mode.take_saved_fetch_rearm() {
                        catalog_request = Some(spawn_saved_catalog_fetch(
                            &client,
                            ui_tx.clone(),
                            cwd.clone(),
                            session_dir.clone(),
                        ));
                        // A superseded fetch's stream stops applying: the
                        // new fetch owns the catalog (TS's generation gate
                        // drops the old refresh's late `onSession` calls).
                        mode.drop_saved_stream();
                        saved_flush = None;
                    }
                    // The executed stop-or-delete dispatch (the second
                    // ctrl+x): the wire call runs off the key loop with
                    // the client — the saved-catalog fetch's pattern —
                    // and its outcome lands as a `DeleteResult` status
                    // line (the roster push refreshes the rows behind
                    // it).
                    if let Some(action) = mode.take_delete_action() {
                        action_dispatches.push(spawn_delete_dispatch(
                            &client,
                            ui_tx.clone(),
                            action,
                        ));
                    }
                    // The confirmed rename, dispatched off the key loop; its outcome lands
                    // as a `RenameResult` status.
                    if let Some(rename) = mode.pending_rename.take() {
                        action_dispatches.push(spawn_rename_dispatch(
                            &client,
                            ui_tx.clone(),
                            rename,
                        ));
                    }
                    // The reply composer's dispatches (the send and the
                    // `/kill` view command): the 2s exit drain covers an
                    // Enter-then-exit the same way it covers a confirmed
                    // stop-or-delete.
                    if let Some(request) = mode.pending_reply.take() {
                        action_dispatches.push(spawn_reply_dispatch(
                            &client,
                            ui_tx.clone(),
                            request,
                        ));
                    }
                    if let Some(request) = mode.pending_kill.take() {
                        action_dispatches.push(spawn_kill_dispatch(
                            &client,
                            ui_tx.clone(),
                            request,
                        ));
                    }
                    // The armed target's headline fetch: detached (the
                    // exit never waits on it), and its keyed result
                    // drops when the composer is gone or re-targeted.
                    if let Some((key, active_session_id)) = mode.pending_headline.take() {
                        spawn_headline_fetch(&client, ui_tx.clone(), key, active_session_id);
                    }
                }
                // A plain click opens the row under it (the Enter
                // action); drags and wheel turns are consumed inside.
                UiInput::Mouse(event) => {
                    mode.handle_mouse(&event);
                }
                UiInput::Paste(text) => {
                    mode.handle_paste(&text);
                }
                // `Settled` is the plan's own settle no-op;
                // `WaitRender` never reaches the batch pop (the
                // pre-pass at the loop head owns it — an armed hold
                // skips this pop entirely).
                UiInput::Resize | UiInput::Settled | UiInput::WaitRender { .. } => {}
                UiInput::DeleteResult {
                    message,
                    tone,
                    deleted_saved_path,
                } => {
                    mode.delete_result(&message, tone, deleted_saved_path);
                }
                UiInput::RenameResult { rename, outcome } => {
                    mode.rename_result(rename, outcome);
                }
                UiInput::HeadlineResult { key, result } => {
                    mode.headline_result(&key, result);
                }
                // The saved-resume path's own status (TS's mid-send
                // "Sending reply..."): it lands between the resume and
                // the prompt like any set_status, never queued behind
                // the result it precedes.
                UiInput::ReplyProgress(text) => {
                    mode.set_status(&text);
                }
                UiInput::ReplyResult { key, outcome } => {
                    mode.reply_result(&key, outcome);
                }
                UiInput::KillResult { key, outcome } => {
                    mode.kill_result(&key, outcome);
                }
                // The saved-catalog scan landed (TS `armSavedSearchFetch`
                // applying its result): the Inactive section builds now.
                UiInput::SavedLoaded { sessions } => {
                    // The final response is the authoritative array: the
                    // stream's unflushed rows are its prefix, and the scan
                    // never re-orders after streaming them. The request is
                    // SETTLED: a late frame the wire still delivers must
                    // not match the request gate and upsert its
                    // un-enriched row over the catalog the response just
                    // settled (the response's rows carry the ledger
                    // enrichment the streamed rows never see).
                    mode.drop_saved_stream();
                    saved_flush = None;
                    catalog_request = None;
                    mode.apply_saved_loaded(sessions);
                    // The failure status is the fetch's own honest error;
                    // the catalog's success retires it (the status line
                    // must not keep reporting an unavailable catalog after
                    // it loaded).
                    if mode
                        .status_text()
                        .is_some_and(|status| status.starts_with("Saved sessions unavailable"))
                    {
                        mode.status = None;
                    }
                    mode.rebuild_rows();
                    // TS `resolveMissingSelectionAnchor`'s finally arm: the
                    // anchor's row can only arrive through THIS fetch, so a
                    // terminal load that still does not carry it ends the
                    // wait - the loading hint must never re-arm on every
                    // open behind a catalog that already settled without
                    // the row. The landing (or the user's first move) ends
                    // the wait earlier; this arm settles what remains.
                    mode.end_anchor_wait();
                }
                UiInput::SavedFailed { error } => {
                    // The catalog settled on a terminal failure (TS
                    // `refreshSavedSessions`'s catch arm: the fetch is
                    // settled, never soft-locking the scope fallback). The
                    // entry anchor's wait ends with it - the anchor's row
                    // can only come from THIS fetch, so keeping the wait
                    // pending would re-arm the loading hint on every open
                    // behind an error the status line already showed (TS
                    // `resolveMissingSelectionAnchor`'s finally arm). The
                    // request is settled too: the failure keeps the last
                    // good rows, and a late frame must not upsert over
                    // them.
                    mode.drop_saved_stream();
                    saved_flush = None;
                    catalog_request = None;
                    mode.settle_anchor_wait_on_saved_failure();
                    mode.saved_fetch_failed = true;
                    mode.set_status_tone(
                        &format!("Saved sessions unavailable: {error}"),
                        StatusTone::Error,
                    );
                }
                // The headless plan ended: the run stops here (the
                // interactive harness's `HeadlessDone` contract). A plan
                // that ends without an exit key still captures its frames
                // and returns instead of spinning forever.
                UiInput::Done => mode.running = false,
            }
            // An exit decision skips sync terminal I/O: a wedged pty must
            // not prevent the reader-armed force-quit deadline from firing.
            if !mode.running {
                break;
            }
            redraw = true;
        } else {
            // The batch window's and the status line's deadlines, copied
            // out of the loop state: select evaluates EVERY branch
            // expression whether or not its precondition passes, so the
            // arms below must never unwrap an Option themselves.
            let flush_at = saved_flush;
            let status_at = mode.status_expiry(std::time::Instant::now());
            tokio::select! {
                    maybe_event = events.recv() => {
                        match maybe_event {
                            Some(DaemonClientEvent::RosterUpdate { changed, removed, resync }) => {
                                mode.apply_roster_update(changed, removed, resync);
                                redraw = true;
                            }
                            // The saved-catalog scan streams its rows while it
                            // runs (newest first): the view buffers the live
                            // fetch's frames and flushes them in one rebuild
                            // per batch window, so the Inactive section (and
                            // the entry anchor's row) appears progressively
                            // instead of after the whole scan (TS
                            // `refreshSavedSessions`'s `onSession` batching).
                            Some(DaemonClientEvent::SessionListItem { session, request_id }) => {
                                if catalog_request.as_deref() == Some(request_id.as_str()) {
                                    mode.buffer_saved_stream_item(session);
                                    if saved_flush.is_none() {
                                        saved_flush = Some(
                                            tokio::time::Instant::now()
                                                + Duration::from_millis(
                                                    SAVED_CATALOG_RECONCILE_INTERVAL_MS,
                                                ),
                                        );
                                    }
                                }
                            }
                            Some(_) => {}
                            None => {
                                mode.set_status_tone("the daemon connection closed",
                                    StatusTone::Error
            );
                                mode.running = false;
                                redraw = true;
                            }
                        }
                    }
                    maybe_input = ui_rx.recv() => {
                        if let Some(input) = maybe_input {
                            pending.push(input);
                            continue;
                        }
                    }
                    // Only a running row needs a periodic frame. The timer
                    // stays tied to the last pulse across unrelated inputs.
                    () = tokio::time::sleep_until(last_pulse + Duration::from_millis(PULSE_INTERVAL_MS)),
                        if mode.rows.iter().any(|row| row.section == Section::Running) => {}
                    // The streamed-catalog batch window: the buffered rows
                    // flush as one rebuild. A closed window pends forever
                    // (the copied deadline is None) instead of unwrapping.
                    () = async {
                        match flush_at {
                            Some(at) => tokio::time::sleep_until(at).await,
                            None => std::future::pending().await,
                        }
                    } => {
                        if mode.flush_saved_stream() {
                            redraw = true;
                        }
                        saved_flush = None;
                    }
                    // The incident-notice poll's wake-up: the deadline drain
                    // below the select does the refresh, so the arm only ends
                    // the wait (the pulse arm's shape).
                    () = tokio::time::sleep_until(incident_poll_at) => {}
                    // The render barrier's deadline: an armed hold whose
                    // needle never lands still pops here — the plan proceeds
                    // and the assertion then reports the actual frame — so a
                    // quiet daemon (a catalog answer that never comes)
                    // cannot wedge the loop waiting on events that never
                    // arrive.
                    () = async {
                        match wait_render_deadline {
                            Some(at) => tokio::time::sleep_until(at).await,
                            None => std::future::pending().await,
                        }
                    } => {}
                    // The status line's expiry wake (TS `setStatusMessage`'s
                    // timer): the line clears at its deadline even on a quiet
                    // view, and the expiry check below repaints it away.
                    () = async {
                        match status_at.map(tokio::time::Instant::from_std) {
                            Some(at) => tokio::time::sleep_until(at).await,
                            None => std::future::pending().await,
                        }
                    } => {}
                }
        }
        // The status line's timer (TS's `setTimeout`): an expired line
        // clears here after every arm — the wake's own and any input's —
        // so a status that aged out mid-batch never survives the
        // redraw that follows.
        redraw |= mode.expire_status(std::time::Instant::now());
        // Coalesce a due animation pulse with the input or roster frame,
        // and a due incident poll behind a busy input stream (the TS
        // interval fires between turns regardless).
        redraw |= advance_running_pulse(&mut mode, &mut last_pulse, tokio::time::Instant::now());
        if tokio::time::Instant::now() >= incident_poll_at {
            incident_poll_at = tokio::time::Instant::now()
                + Duration::from_millis(crate::incident_notices::INCIDENT_NOTICE_POLL_INTERVAL_MS);
            redraw |= mode.refresh_incident_notices();
        }
        if redraw {
            renderer.draw(&mut mode);
        }
    }

    // The view decided to leave. The force-quit deadline arms below,
    // after the stop-or-delete drain settles: a confirmed request
    // completes before any deadline can cut it down. `renderer.finish`
    // consumes the renderer, so the terminal check is read first.
    let handing_off = mode.opened.is_some() || mode.new_session;
    let terminal_exit = matches!(renderer, Renderer::Terminal { .. }) && !handing_off;
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
                    rest: serde_json::Map::default(),
                })
                .await;
        });
    }
    let opened = mode.opened.take();
    // A handoff retires the watchdog before the drain wait: the reader
    // keeps observing Ctrl+C through that window, and a double-press
    // must not force-quit a process that is merely switching views —
    // the retirement never affects the in-flight dispatches.
    if handing_off {
        exit_guard.cancel();
    }
    // An in-flight stop-or-delete dispatch settles before the connection
    // closes (bounded): an exit right after the second ctrl+x must not
    // drop the request on the floor (the loop's client close would take
    // the connection down before the detached task ever sent).
    // One bounded window covers every in-flight dispatch: they run
    // concurrently, so the exit wait stays the same size no matter
    // how many confirms are outstanding.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    for dispatch in action_dispatches {
        let _ = tokio::time::timeout_at(deadline, dispatch).await;
    }
    // Apply queued delete/rename results before the catalog snapshot, so the
    // next view run does not show a deleted path or the old saved name.
    for input in std::mem::take(&mut pending)
        .into_iter()
        .chain(std::iter::from_fn(|| ui_rx.try_recv().ok()))
    {
        match input {
            UiInput::DeleteResult {
                message,
                tone,
                deleted_saved_path,
            } => {
                mode.delete_result(&message, tone, deleted_saved_path);
            }
            UiInput::RenameResult { rename, outcome } => {
                mode.rename_result(rename, outcome);
            }
            // The reply outcomes apply on the exit path too (an
            // Enter-then-exit): the statuses paint nothing on a run
            // that ended, but the adoption actions (`reply_sent`,
            // `killed`) must still reach the outcome — and a `/name`
            // result still disarms or restores the composer's draft for
            // the run's final state.
            UiInput::HeadlineResult { key, result } => {
                mode.headline_result(&key, result);
            }
            UiInput::ReplyProgress(text) => {
                mode.set_status(&text);
            }
            UiInput::ReplyResult { key, outcome } => {
                mode.reply_result(&key, outcome);
            }
            UiInput::KillResult { key, outcome } => {
                mode.kill_result(&key, outcome);
            }
            _ => {}
        }
    }
    // The force-quit deadline arms only after the drain: the drain
    // window is bounded, so it never wedges, and the watchdog then
    // covers the teardown's remaining best-effort leaves (the client
    // close over a possibly dead daemon, the return path). A selection
    // (or a new session) is a view switch, not an exit: the process
    // keeps running and TS has no exit deadline on this path, so the
    // deadline covers only the leaves that end this process.
    if terminal_exit {
        exit_guard.arm_for_exit();
    }
    // A handoff returns the roster connection for the flow's next view run
    // (TS `persistentState.rosterClient`); a selection-less exit closes it.
    let link = if opened.is_some() || mode.new_session {
        // The handoff link carries the catalog the run loaded (TS
        // `persistentState.savedSessions`/`savedCatalogLoaded`): the flow's
        // next view run paints the Inactive rows it already holds on its
        // first frame and skips the fetch when this one loaded them.
        Some(AgentsViewLink {
            client,
            events,
            saved_sessions: mode.saved.clone(),
            saved_catalog_loaded: mode.saved_catalog_loaded,
        })
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
            scope_back: mode.scope_back,
            expanded_ancestors: opened
                .as_ref()
                .map(|row| row.expanded_ancestors.clone())
                .unwrap_or_default(),
            selected_row_identity: opened.as_ref().map(|row| row.selected_row_identity.clone()),
            selected_key: opened.as_ref().map(|row| row.selected_key.clone()),
            opened_rlm_depth: opened.as_ref().and_then(|row| row.rlm_depth),
            opened_has_children: opened.as_ref().is_some_and(|row| row.has_children),
            opened_cwd: opened
                .as_ref()
                .and_then(|row| row.cwd.clone())
                .map(std::path::PathBuf::from),
            status_message: opened.as_ref().and_then(|row| row.status_message.clone()),
            actions: std::mem::take(&mut mode.actions),
            incident_notice_state: mode.incident_notice_state,
        },
    })
}

/// Advance the running icon at its fixed cadence, independent of other inputs.
fn advance_running_pulse(
    mode: &mut AgentsViewMode,
    last_pulse: &mut tokio::time::Instant,
    now: tokio::time::Instant,
) -> bool {
    if mode.rows.iter().any(|row| row.section == Section::Running)
        && now.duration_since(*last_pulse) >= Duration::from_millis(PULSE_INTERVAL_MS)
    {
        *last_pulse = now;
        mode.pulse = mode.pulse.wrapping_add(1);
        true
    } else {
        false
    }
}

/// The daemon-driven answers that jump an armed render barrier: the
/// saved catalog's landing (or its terminal failure) and the
/// stop-or-delete dispatch results are the events the plan's needles
/// wait on — they must never queue behind the hold they satisfy.
fn is_daemon_answer(input: &UiInput) -> bool {
    matches!(
        input,
        UiInput::SavedLoaded { .. }
            | UiInput::SavedFailed { .. }
            | UiInput::DeleteResult { .. }
            | UiInput::RenameResult { .. }
            | UiInput::HeadlineResult { .. }
            | UiInput::ReplyProgress(_)
            | UiInput::ReplyResult { .. }
            | UiInput::KillResult { .. }
    )
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
mod tests;
