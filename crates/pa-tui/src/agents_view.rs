//! The agents view: the unified live-roster + saved-catalog session list.
//! Rows group into Running/Idle/Inactive sections, the inline prompt doubles
//! as search, and the first actions are open (attach a live session) and
//! resume (reopen a saved file); `n` starts a new session.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use pa_types::daemon::DaemonCommand;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::agents_view_forest::{
    ancestor_session_ids, build_rows, compute_rollups, has_session_children, resolve_selection,
    scope_ancestors, scope_root, scope_to_subtree, AgentsViewRow, RowKind, ScopeRoot, SelectionKey,
    SessionActivity,
};
use crate::agents_view_state::truncate_text;
use crate::agents_view_state::{
    build_layout, filter_empty_sessions, filter_unified_sessions, parse_search_query,
    reconcile_unified_sessions, section_title, RowLayout, Section,
};

/// The scope a scoped view opened on (TS `AgentsViewScopeKey` plus the display name): lists this
/// session's descendants; the back key returns to it.
pub use crate::agents_view_forest::AgentsViewScope;
pub use crate::agents_view_forest::SelectionKey as AgentsViewSelectionKey;
use crate::daemon_client::{DaemonClient, DaemonClientEvent};
use crate::interactive::{SessionPanel, SessionSelection};
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
mod heartbeats;
mod persistent_shells;
mod session_activity;

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

#[derive(Debug, Clone)]
pub struct AgentsViewOptions {
    pub socket_path: PathBuf,
    pub cwd: PathBuf,
    pub session_dir: Option<PathBuf>,
    pub theme: String,
    pub version: String,
    /// The session the view was opened from: anchors a fresh open's entry selection on its row.
    pub anchor_session_id: Option<String>,
    /// Open scoped to one session's subtree: the root lists its descendants.
    pub scope: Option<AgentsViewScope>,
    pub query: Option<String>,
    /// Session ids to re-expand on open, root-most first (a drilled-in return re-opens the tree).
    pub expanded_ancestors: Vec<String>,
    pub selected_row_identity: Option<String>,
    /// The selection key that survives an identity flip.
    pub selected_key: Option<SelectionKey>,
    /// A status message the previous run left for this one (the unattachable-child fallback).
    pub status_message: Option<String>,
    /// The effective keybindings (user `keybindings.json` over the defaults): every action and
    /// hint dispatches through this, the same contract as the session view.
    pub keybindings: crate::keybindings::KeybindingsManager,
    /// The `showHardwareCursor` setting snapshot: the caret moves for IME every frame, shown only
    /// when set.
    pub show_hardware_cursor: bool,
    /// The incident notice state carried across view runs (a dismissed incident
    /// never comes back); `None` on the first run creates a fresh state.
    pub incident_notice_state: Option<crate::incident_notices::IncidentNoticeState>,
    /// The flow's own `create` config: the base a saved reply's resume derives its
    /// config from (the session's cwd removed, or the view's cwd when the saved
    /// directory no longer exists).
    pub create_config: serde_json::Value,
}

/// The open action the run ended with (TS `AgentsViewRunResult`'s
/// `open`/`scope_back` arms, unified): the session the flow opens plus
/// the row metadata it carries across the view/session loop — the new
/// sessions open the same way (TS `createNewSession`'s
/// `finish({ type: "open" })`).
#[derive(Debug, Clone, PartialEq)]
pub struct OpenedRow {
    pub selection: SessionSelection,
    pub expanded_ancestors: Vec<String>,
    pub selected_row_identity: String,
    pub selected_key: SelectionKey,
    pub rlm_depth: Option<u32>,
    pub has_children: bool,
    pub status_message: Option<String>,
    /// The opened session's own directory (the roster summary's `cwd`): the session run rides it
    /// as its cwd, not the view's launch directory.
    pub cwd: Option<String>,
    /// The panel the opened session mounts (an activity line's or a persistent shell row's open).
    pub panel: Option<SessionPanel>,
}

pub enum AgentsViewUiMode {
    Terminal,
    /// Headless plan: typed input plus settle barriers, frames captured for the parity verifier.
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
    /// Hold until a frame rendered after this step contains `needle` (bounded by `timeout_ms`):
    /// the condition wait for daemon-driven rows.
    WaitRender { needle: String, timeout_ms: u64 },
    /// A plain left click on one screen cell (zero-based).
    Click { row: usize, col: usize },
    /// A raw SGR mouse sequence, decoded by the same parser the terminal's reports flow through.
    Mouse(String),
    /// Wake the waiter once the plan reaches this step (every preceding step, barriers included,
    /// has run): hands control back to a test whose next action must follow a rendered state.
    Notify(std::sync::Arc<tokio::sync::Notify>),
}

#[derive(Debug, Default)]
pub struct AgentsViewOutcome {
    /// The session the user opened; `None` when the flow exits here.
    pub selection: Option<SessionSelection>,
    pub frames: Vec<String>,
    pub query: Option<String>,
    /// The view exited through its parent key while scoped: the flow pops the scope frame.
    pub scope_popped: bool,
    /// The scope root left the roster mid-run: the flow drops the scope frame.
    pub scope_dropped: bool,
    /// The scoped panel handed the pane back to its scope root's chat: the reopened chat starts
    /// with the dock focused on the panel's own group, not the prompt bar.
    pub scope_back: bool,
    /// Session ids of the opened row's ancestors, root-most first: the next view run re-expands
    /// the tree to the drilled row.
    pub expanded_ancestors: Vec<String>,
    pub selected_row_identity: Option<String>,
    pub selected_key: Option<SelectionKey>,
    /// The opened session's `rlmDepth`: a drilled-in child renders its `depth N` tray label.
    pub opened_rlm_depth: Option<u32>,
    pub opened_has_children: bool,
    /// The opened session's own directory (the roster summary's `cwd`): the session run rides it
    /// as its cwd, not the launch directory.
    pub opened_cwd: Option<std::path::PathBuf>,
    /// A status message the session opener left (the unattachable-child fallback).
    pub status_message: Option<String>,
    /// The panel the opened session mounts (an activity line's or a persistent shell row's open).
    pub panel: Option<SessionPanel>,
    /// The view actions this run performed (`program_shown`, `renamed`): the composition root
    /// emits the `tui agents action` adoption events at the run's end.
    pub actions: Vec<&'static str>,
    pub incident_notice_state: crate::incident_notices::IncidentNoticeState,
}

/// The running-row icon frame cadence (TS `WORKING_ICON_INTERVAL_MS`).
const PULSE_INTERVAL_MS: u64 = 250;

/// The saved-catalog stream's batch window: rows reconcile on this cadence (progressive render).
const SAVED_CATALOG_RECONCILE_INTERVAL_MS: u64 = 75;

/// The session files one saved-catalog page folds: the first fetch and every scroll fetch ask for
/// this many (several screens' worth); a search asks for the whole rest of the store.
const SAVED_CATALOG_PAGE_FILES: u64 = 200;

/// The part of the store the catalog has not folded yet: its file count and the daemon's cursor
/// that resumes the walk.
#[derive(Clone)]
struct SavedMore {
    remaining: u64,
    cursor: String,
}

/// The saved catalog a view run holds; the handoff link carries it to the flow's next run.
#[derive(Default)]
struct SavedCatalog {
    sessions: Vec<Value>,
    loaded: bool,
    more: Option<SavedMore>,
}

/// The transient status hint while the entry anchor still waits on its row.
const ANCHOR_LOADING_HINT: &str = "Still loading sessions — press ↓ or ↑ to pick a session now.";

/// The saved-catalog fetch's request budget: the LONG-RUNNING class, never the 30s default —
/// the whole-file re-parse takes over a minute on a large dir.
fn saved_catalog_timeout_ms() -> u64 {
    crate::daemon_client::LONG_RUNNING_REQUEST_TIMEOUT_MS
}

enum UiInput {
    Key(String),
    /// One paste (bracketed, or the reader's coalesced marker-less burst): the armed
    /// composer's editor takes it; the search field ignores it.
    Paste(String),
    /// The headless plan's `WaitRender` barrier: holds the queued batch until a post-arming
    /// frame matches.
    WaitRender {
        needle: String,
        timeout_ms: u64,
    },
    /// A decoded SGR mouse report (the click grammar's input).
    Mouse(crate::mouse::MouseEvent),
    /// The headless plan's `Notify` step, popped in plan order.
    Notify(std::sync::Arc<tokio::sync::Notify>),
    Resize,
    Settled,
    Done,
    /// The saved-catalog fetch landed: the Inactive section rebuilds from these rows. A
    /// `continued` fetch (one that resumed a cursor) adds its rows to the catalog.
    SavedLoaded {
        sessions: Vec<Value>,
        more: Option<SavedMore>,
        continued: bool,
    },
    /// The saved-catalog fetch failed; the status line reports it.
    SavedFailed {
        error: String,
    },
    /// One stop-or-delete dispatch landed: the status line reports the outcome in the
    /// tone the dispatch classified it with.
    DeleteResult {
        message: String,
        tone: StatusTone,
        /// The deleted saved session's path (the catalog key); `None` for the other arms.
        deleted_saved_path: Option<String>,
    },
    /// One rename dispatch landed (the ctrl+r flow): the status line reports the outcome.
    RenameResult {
        rename: Rename,
        outcome: Result<(), String>,
    },
    /// The armed target's headline landed (or failed): the header renders it; a
    /// re-targeted or disarmed composer drops it.
    HeadlineResult {
        key: String,
        result: Result<Option<String>, String>,
    },
    /// The saved-resume path's mid-send status ("Sending reply..." after "Resuming
    /// session..."): the loop paints each as it lands, never both at once.
    ReplyProgress(String),
    /// One reply send landed: the resumed summary and sticky cwd notice, or the
    /// wire's error.
    ReplyResult {
        key: String,
        outcome: Result<reply::ReplySent, String>,
    },
    /// One `/kill` view-command dispatch landed.
    KillResult {
        key: String,
        outcome: Result<(), String>,
    },
    /// A heartbeat-catalog fetch landed (TS `refreshHeartbeats`'s apply):
    /// rows re-render their `◷` counts.
    HeartbeatsLoaded {
        generation: u64,
        heartbeats: Vec<crate::heartbeats_picker::HeartbeatEntry>,
    },
    /// A `list_persistent_shells` fetch landed (`None`: it failed, the last list stays).
    PersistentShellsLoaded(Option<Value>),
    /// The open bash view's output tail for shell `id`, stamped with its open's generation.
    PersistentShellTail {
        id: String,
        generation: u64,
        outcome: Result<String, String>,
    },
    /// A persistent-shell kill settled.
    PersistentShellKilled {
        id: String,
        outcome: Result<(), String>,
    },
    /// One shells/factory-runs fetch cycle landed: the activity lines re-count.
    SessionActivityLoaded(Vec<session_activity::ActivityRead>),
}

/// The flow's roster connection: one daemon connection alive across the flow's view runs, so a
/// handoff back from a chat reuses it instead of reconnecting.
pub struct AgentsViewLink {
    client: DaemonClient,
    events: mpsc::UnboundedReceiver<DaemonClientEvent>,
    /// The saved catalog the previous view run loaded: a re-entry paints the Inactive rows it
    /// already holds on its FIRST frame, and a loaded catalog skips the re-fetch.
    saved: SavedCatalog,
    /// The activity counts the previous run held: a re-entry renders the line the user opened on
    /// its first frame, so the carried selection restores onto it.
    session_activity: std::collections::HashMap<String, SessionActivity>,
    /// The persistent shells list the previous run held, for the same first-frame restore of a
    /// shell row.
    persistent_shells: Value,
    /// An unfinished cycle follows the roster link across session handoffs; re-entry consumes
    /// its result instead of starting another batch while these requests still wait.
    activity_fetch: Option<tokio::sync::oneshot::Receiver<Vec<session_activity::ActivityRead>>>,
}

impl AgentsViewLink {
    async fn connect(socket_path: &std::path::Path) -> Result<Self> {
        let (client, events) = DaemonClient::connect_with_retry(socket_path).await?;
        Ok(Self {
            client,
            events,
            saved: SavedCatalog::default(),
            session_activity: std::collections::HashMap::new(),
            persistent_shells: Value::Null,
            activity_fetch: None,
        })
    }

    /// Release the connection; the supervisor drops the roster subscription with the socket.
    pub fn close(&self) {
        self.client.close();
    }
}

/// One agents-view run plus the roster connection it kept alive for the next run in the same
/// flow (`None` when the run exited fully and closed it).
pub struct AgentsViewRun {
    pub outcome: AgentsViewOutcome,
    pub link: Option<AgentsViewLink>,
}

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
    /// The status line: rendered at the bottom hint row in its tone, expired by the
    /// loop's deadline arm, sticky lines cleared by the next key.
    status: Option<Status>,
    /// A multi-line notice from the previous run, rendered as a dismissible panel above the hint
    /// line so the full text stays readable.
    notice: Option<String>,
    /// The armed stop-or-delete confirm, keyed by row identity: first ctrl+x arms, second press
    /// executes, any other key clears.
    pending_delete: Option<PendingDelete>,
    /// The prompt's composition state: the search field, or the rename composer while a rename
    /// composes.
    composer: Composer,
    /// The confirmed rename the run loop dispatches (the wire call runs off the key loop with the
    /// client).
    pending_rename: Option<Rename>,
    /// The submitted reply the run loop dispatches: the send runs off the key loop
    /// with the client, and its keyed outcome re-enters as a `ReplyResult`.
    pending_reply: Option<ReplyRequest>,
    /// One `/kill` view command the run loop dispatches; its keyed outcome re-enters
    /// as a `KillResult`.
    pending_kill: Option<KillRequest>,
    /// The armed target whose headline fetch runs (its key and active id): the fetch
    /// is detached, and its keyed result drops when the composer is gone or
    /// re-targeted.
    pending_headline: Option<(String, String)>,
    /// The executed delete the run loop takes (the dispatch runs off the key loop with the client).
    pending_delete_action: Option<DeleteAction>,
    /// Session paths deleted this run: an in-flight saved-catalog response can still carry a
    /// deleted file, so the catalog apply filters these paths out.
    deleted_saved_paths: std::collections::HashSet<String>,
    /// The scope root's facts the scoped view renders and creates with
    /// ([`ScopeRoot`]); `None` when the scope root is not on the roster
    /// (the view falls back to the global list with a status message, TS
    /// scope-resolution fallback).
    scope_root: Option<ScopeRoot>,
    /// The scope root resolved on the last rebuild.
    scope_active: bool,
    /// Whether the scope root left the roster mid-run: reported on the outcome so the flow drops
    /// the scope.
    scope_dropped: bool,
    expanded_parents: std::collections::HashSet<String>,
    /// Parent row identities whose spawn programs render inside their open list. Unlike TS,
    /// it never carries across view runs: a shown program without its expansion is meaningless.
    program_shown_parents: std::collections::HashSet<String>,
    /// Session ids to expand on the next rebuild (consumed once).
    pending_ancestors: Option<Vec<String>>,
    selected_identity: Option<String>,
    /// The selection key that survives an identity flip.
    selected_key: Option<SelectionKey>,
    /// Whether the entry selection still waits on the anchor session's row: a fresh
    /// open lands the selection there once the row appears; the first user move cancels the wait.
    anchor_selection_pending: bool,
    /// The selection a cleared search returns to: the row selected when
    /// the query went non-empty. A move while searching drops it, so the
    /// clear keeps the user's pick.
    search_return: Option<(String, SelectionKey)>,
    /// First ctrl+c shows the exit hint; the second exits.
    exit_armed: bool,
    /// The double-Ctrl+C force-quit guard (the shared instance is installed by `run_agents_view`
    /// after `new`).
    exit_guard: crate::exit_guard::ExitGuard,
    pulse: usize,
    running: bool,
    /// The view exited through its parent key: the flow pops the scope frame.
    scope_popped: bool,
    /// The scoped panel handed the pane back to its scope root's chat (the reopened chat focuses
    /// the dock on the panel's own group, not the prompt bar).
    scope_back: bool,
    /// The open action the run ended with (`None` while the view runs).
    opened: Option<OpenedRow>,
    /// The effective keybindings (TS `AgentsViewMode.keybindings`): every
    /// action and hint dispatches through this manager.
    keybindings: crate::keybindings::KeybindingsManager,
    /// The terminal height of the last rendered frame; 0 before the first render, where `page_step`
    /// floors to the 4-row minimum anyway.
    last_height: usize,
    /// The saved-catalog fetch settled on a terminal failure: the next query change re-arms one
    /// retry.
    saved_fetch_failed: bool,
    incident_notice_state: crate::incident_notices::IncidentNoticeState,
    /// A failed saved-catalog fetch wants re-arming on the query's next change (the loop owns
    /// the client, so the mode records the intent).
    saved_query_rearm: bool,
    /// The streamed rows waiting for the batch window: one rebuild per window makes them appear
    /// progressively — the anchor's row lands long before the scan's final response.
    saved_stream: Vec<Value>,
    /// The catalog settled on a successful load: no fetch while it holds, and the exit link
    /// carries it so the next run skips its own fetch.
    saved_catalog_loaded: bool,
    /// The store files the catalog has not folded yet; a scroll near the end or a search
    /// fetches them.
    saved_more: Option<SavedMore>,
    saved_page_requested: bool,
    /// The screen rows of the rendered session rows, in frame order — exactly the rows the last
    /// frame painted (a plain left click opens the row under it). Rebuilt on every render.
    click_rows: Vec<(usize, usize)>,
    /// The frame row under the mouse (operator directive 2026-09-29): revalidated against each
    /// render's click rows; `None` over anything else.
    hover_row: Option<usize>,
    /// The left press a release may fire: the pressed row and whether it turned into a drag —
    /// a dragged release never opens.
    pressed_click: Option<PressedMouseClick>,
    /// The view actions this run performed (`program_shown`, `renamed`), reported on the outcome
    /// for the composition root's adoption events.
    actions: Vec<&'static str>,
    /// The daemon's heartbeat catalog (the dock's source, TS
    /// `heartbeats`): each row counts its own session's jobs.
    heartbeats: Vec<crate::heartbeats_picker::HeartbeatEntry>,
    /// The latest `list_persistent_shells` data: every persistent shell machine-wide.
    persistent_shells: Value,
    /// The bash view an orphan's open mounts over the list.
    shell_view: Option<crate::bash_view::BashView>,
    /// The open bash view's action the run loop dispatches (output fetch or kill).
    pending_shell_action: Option<crate::bash_view::BashViewAction>,
    /// The shell whose open waits on the daemon's walk of the rest of the saved store: its
    /// session opens once the walk lists it, the orphan view once the walk ends without it.
    pending_shell_open: Option<String>,
    /// Each live session's own shells and factory-run counts, keyed by `activeSessionId`.
    session_activity: std::collections::HashMap<String, SessionActivity>,
}

/// The press state of one left click, row-scoped: the release must land on the same row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PressedMouseClick {
    row: usize,
    dragged: bool,
}

/// The prompt's composition state: the plain search field, or one action's composer
/// that owns the prompt and the key routing. Each composer owns its [`Editor`] — the
/// text, provider, and history never leak between modes. [`Box`] keeps the variant
/// against the unit `Search` under clippy's large-enum-variant.
enum Composer {
    Search,
    Rename(Box<rename::RenameComposer>),
    Reply(Box<reply::ReplyComposer>),
}

impl AgentsViewMode {
    fn new(mut options: AgentsViewOptions) -> Self {
        let theme = crate::app::load_theme(&options.theme);
        let query = options.query.clone().unwrap_or_default();
        // A multi-line notice renders as the dismissible panel; a single line keeps the hint-line
        // status.
        let (status, notice) = match options.status_message.clone() {
            Some(message) if message.contains('\n') => (None, Some(message)),
            // The carried line seeds the run's status with the default tone rule
            // and the timer, exactly like any later line.
            status => (status.as_deref().map(Status::transient), None),
        };
        let pending_ancestors =
            (!options.expanded_ancestors.is_empty()).then(|| options.expanded_ancestors.clone());
        let selected_identity = options.selected_row_identity.clone();
        let selected_key = options.selected_key.clone();
        let keybindings = options.keybindings.clone();
        // A fresh open (the scope-back handoff leaks an empty identity and a key with no session
        // ids) waits on the anchor: the session the view was opened from.
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
        // The first run starts fresh; later runs continue the carried state.
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
            scope_root: None,
            scope_active: false,
            scope_dropped: false,
            expanded_parents: std::collections::HashSet::default(),
            program_shown_parents: std::collections::HashSet::default(),
            pending_ancestors,
            selected_identity,
            selected_key,
            anchor_selection_pending,
            search_return: None,
            exit_armed: false,
            exit_guard: crate::exit_guard::ExitGuard::new(),
            pulse: 0,
            running: true,
            scope_popped: false,
            scope_back: false,
            opened: None,
            saved_fetch_failed: false,
            saved_query_rearm: false,
            saved_stream: Vec::new(),
            saved_catalog_loaded: false,
            saved_more: None,
            saved_page_requested: false,
            incident_notice_state,
            click_rows: Vec::new(),
            hover_row: None,
            pressed_click: None,
            actions: Vec::new(),
            heartbeats: Vec::new(),
            persistent_shells: Value::Null,
            shell_view: None,
            pending_shell_action: None,
            pending_shell_open: None,
            session_activity: std::collections::HashMap::new(),
        }
    }
}

/// Open the roster connection and pull the first snapshot: a parked connection comes first
/// (a dead one reconnects once); racing updates apply idempotently by agent id. Errors leave
/// any opened connection closed.
async fn open_roster_link(
    options: &AgentsViewOptions,
    link: Option<AgentsViewLink>,
) -> Result<(
    DaemonClient,
    mpsc::UnboundedReceiver<DaemonClientEvent>,
    Vec<Value>,
    SavedCatalog,
)> {
    let AgentsViewLink {
        mut client,
        mut events,
        saved,
        ..
    } = match link {
        Some(link) => link,
        None => AgentsViewLink::connect(&options.socket_path)
            .await
            .with_context(|| "the agents view could not attach to the daemon")?,
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
    Ok((client, events, roster, saved))
}

/// The saved-catalog fetch: the result (or failure) re-enters the loop as a `UiInput`, while
/// the scan's events ride the fetch's request id — the id the loop compares. A terminal
/// failure re-arms on the next query change. `cursor` resumes a previous page's walk; `limit`
/// caps the files it folds (`None` walks the rest of the store).
fn spawn_saved_catalog_fetch(
    client: &DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    cwd: PathBuf,
    session_dir: Option<PathBuf>,
    cursor: Option<String>,
    limit: Option<u64>,
) -> String {
    static CATALOG_FETCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let client = client.clone();
    // The id rides the supervisor reader's `daemon_` namespace: the socket-close failure pass must
    // cover the fetch, or a dead connection leaves the scan's oneshot armed until its whole budget.
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
                    limit,
                    cursor: cursor.clone(),
                    rest: serde_json::Map::default(),
                },
                &request_id,
                saved_catalog_timeout_ms(),
            )
            .await;
        let input = match saved {
            Ok(response) if response.success => {
                let data = response.data.unwrap_or_default();
                UiInput::SavedLoaded {
                    sessions: data
                        .get("sessions")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                    more: data
                        .get("nextCursor")
                        .and_then(Value::as_str)
                        .map(|next| SavedMore {
                            remaining: data
                                .get("remaining")
                                .and_then(Value::as_u64)
                                .unwrap_or_default(),
                            cursor: next.to_string(),
                        }),
                    continued: cursor.is_some(),
                }
            }
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

/// Run the agents view over the roster link (terminal or headless) and return its run state.
///
/// # Errors
///
/// Returns `Err` when the view surface fails; a terminal-mode error runs the exit restore first
/// when this run mounted the surface or adopted a pane already in TUI state.
pub async fn run_agents_view(
    options: AgentsViewOptions,
    ui: AgentsViewUiMode,
    link: Option<AgentsViewLink>,
) -> Result<AgentsViewRun> {
    // Every error return funnels through the one exit restore (an early `?` must not hand the
    // shell a terminal still in TUI state); a pre-mount error must not tear down what the
    // caller had up.
    let owns_terminal = matches!(ui, AgentsViewUiMode::Terminal);
    let surface_mounted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mounted = std::sync::Arc::clone(&surface_mounted);
    match run_agents_view_surface(options, ui, link, mounted).await {
        Ok(run) => Ok(run),
        Err(error) => {
            // Same rule as the session surface: restore when this run changed the terminal state OR
            // entered on a pane already in TUI state.
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
    mut link: Option<AgentsViewLink>,
    surface_mounted: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<AgentsViewRun> {
    crossterm::style::force_color_output(true);
    let session_activity = link
        .as_mut()
        .map(|link| std::mem::take(&mut link.session_activity))
        .unwrap_or_default();
    let persistent_shells = link
        .as_mut()
        .map(|link| std::mem::take(&mut link.persistent_shells))
        .unwrap_or_default();
    let mut activity_fetch = link.as_mut().and_then(|link| link.activity_fetch.take());
    // This pane may arrive already in TUI state (the chat's teardown preserves it), so a
    // roster-link failure here must hand the terminal back before the error escapes.
    let (client, mut events, roster, saved) = match open_roster_link(&options, link).await {
        Ok(open) => open,
        Err(error) => {
            if matches!(ui, AgentsViewUiMode::Terminal) {
                crate::exit_restore::restore_terminal();
            }
            return Err(error);
        }
    };

    // The double-Ctrl+C force-quit guard: same contract as the session loop.
    let exit_guard = crate::exit_guard::ExitGuard::new();
    let mut mode = AgentsViewMode::new(options.clone());
    mode.exit_guard = exit_guard.clone();

    mode.roster = roster;
    // The flow's carried catalog paints on the FIRST frame (a loaded catalog means no fetch
    // below).
    mode.saved = saved.sessions;
    mode.saved_catalog_loaded = saved.loaded;
    mode.saved_more = saved.more;
    mode.session_activity = session_activity;
    mode.persistent_shells = persistent_shells;
    mode.rebuild_rows();
    // The notice from the log's bounded tail paints on the FIRST frame, before the interval's
    // first tick.
    mode.refresh_incident_notices();

    let (ui_tx, mut ui_rx) = mpsc::unbounded_channel::<UiInput>();
    // A panic anywhere between the mount below and the deliberate teardown must still hand the
    // terminal back whole (the same unwind-guard contract the session surface arms).
    let _surface_restore = crate::exit_restore::SurfaceRestore::armed();
    let mut renderer = Renderer::setup(
        ui,
        ui_tx.clone(),
        exit_guard.clone(),
        &surface_mounted,
        options.show_hardware_cursor,
    )?;
    // The first frame renders from the live roster the moment the surface mounts: the
    // saved-catalog fetch applies as an input when it lands instead of holding the frame.
    renderer.draw(&mut mode);
    // The saved catalog feeds the Inactive section (cwd + sessionDir scope); the scan runs while
    // the view is already interactive, so a large catalog never delays the first frame. The re-arm
    // closure shares these clones (the mode never holds the client).
    let cwd = mode.options.cwd.clone();
    let session_dir = mode.options.session_dir.clone();
    // Drain broadcast frames that landed on the parked connection while the view was closed: the
    // fresh roster snapshot supersedes them, and the drain must run BEFORE the catalog fetch spawns
    // or it could discard the fetch's first `session_list_item` frames.
    while events.try_recv().is_ok() {}
    // A loaded catalog never re-fetches; a first run - or one whose previous fetch failed - arms
    // the fetch below.
    let mut catalog_request = (!mode.saved_catalog_loaded).then(|| {
        spawn_saved_catalog_fetch(
            &client,
            ui_tx.clone(),
            cwd.clone(),
            session_dir.clone(),
            None,
            Some(SAVED_CATALOG_PAGE_FILES),
        )
    });
    // The heartbeat catalog feeds the rows' `◷ N` badges: the same
    // selector-less `heartbeats_list` the activity dock reads, fetched
    // open-time like TS `refreshHeartbeats` and re-read on every
    // `heartbeats_changed` (the loop local below is the generation gate:
    // a superseded fetch's answer never applies).
    let mut heartbeat_generation: u64 = 1;
    heartbeats::spawn_heartbeat_catalog_fetch(&client, ui_tx.clone(), heartbeat_generation);
    // The persistent shells' list poll: one fetch in flight, the next armed when it lands.
    if client.supports_server_capability(persistent_shells::CAPABILITY) {
        persistent_shells::spawn_list_fetch(&client, ui_tx.clone());
    }
    let mut shells_fetch_at: Option<tokio::time::Instant> = None;
    // The activity lines' counts: one cycle in flight at a time, the next armed when it lands.
    if activity_fetch.is_none() {
        activity_fetch = Some(session_activity::spawn_session_activity_fetch(
            &client,
            mode.live_session_ids(),
        ));
    }
    let mut activity_fetch_at: Option<tokio::time::Instant> = None;
    // TS `start()`'s open-time settle (`armSavedSearchFetch` followed by
    // `resolveMissingSelectionAnchor`): a carried catalog arms no fetch,
    // so no terminal load ever arrives to settle the entry anchor's wait -
    // resolve it now. The anchor's row either landed from the carry's
    // rebuild above or the catalog already settled without it; an armed
    // fetch keeps the wait (its load settles it).
    if catalog_request.is_none() {
        mode.settle_carried_anchor();
    }
    let mut pending: Vec<UiInput> = Vec::new();
    let mut last_pulse = tokio::time::Instant::now();
    // The incident-notice poll: re-read appended agent.jsonl bytes, re-rendered only on a changed
    // collapsed line.
    let mut incident_poll_at = tokio::time::Instant::now()
        + Duration::from_millis(crate::incident_notices::INCIDENT_NOTICE_POLL_INTERVAL_MS);
    // The saved-catalog stream's open batch window: the first buffered row arms it, the flush
    // closes it.
    let mut saved_flush: Option<tokio::time::Instant> = None;
    // In-flight delete/rename dispatches; teardown waits for them so an exit
    // right after a confirmed action does not drop the request.
    let mut action_dispatches: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    // The headless plan's render barrier: an armed hold's deadline, and the frames captured at
    // arming (the condition scans only post-arming frames).
    let mut wait_render_deadline: Option<tokio::time::Instant> = None;
    let mut wait_render_baseline: usize = 0;

    while mode.running {
        let mut redraw = false;
        // `WaitRender` holds the queued plan batch until a post-arming frame contains the needle;
        // the daemon-driven answers jump the hold (the promotion below), or the catalog's landing
        // would wedge the wait on its own condition.
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
                    // The deadline pops the hold and the plan proceeds; the status note reports the
                    // wait, never the needle — quoting it would satisfy the failed condition.
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
                    // The parked suggestion request materializes once the key's edits
                    // landed.
                    mode.materialize_composer_autocomplete();
                    // The executed stop-or-delete dispatch (the second ctrl+x): the wire call runs
                    // off the key loop, its outcome lands as a `DeleteResult` status line.
                    if let Some(action) = mode.take_delete_action() {
                        action_dispatches.push(spawn_delete_dispatch(
                            &client,
                            ui_tx.clone(),
                            action,
                        ));
                    }
                    // The confirmed rename, dispatched off the key loop; its outcome lands as a
                    // `RenameResult` status.
                    if let Some(rename) = mode.pending_rename.take() {
                        action_dispatches.push(spawn_rename_dispatch(
                            &client,
                            ui_tx.clone(),
                            rename,
                        ));
                    }
                    // The reply composer's dispatches: the 2s exit drain covers an
                    // Enter-then-exit the same way it covers a confirmed stop-or-delete.
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
                    if let Some((key, active_session_id)) = mode.pending_headline.take() {
                        spawn_headline_fetch(&client, ui_tx.clone(), key, active_session_id);
                    }
                }
                // A plain click opens the row under it; drags and wheel turns are consumed inside.
                UiInput::Mouse(event) => {
                    mode.handle_mouse(&event);
                }
                UiInput::Paste(text) => {
                    mode.handle_paste(&text);
                }
                UiInput::Notify(notify) => notify.notify_one(),
                // `Settled` is the plan's own settle no-op; `WaitRender` never reaches the batch
                // pop (the pre-pass at the loop head owns it).
                UiInput::Resize | UiInput::Settled | UiInput::WaitRender { .. } => {}
                UiInput::DeleteResult {
                    message,
                    tone,
                    deleted_saved_path,
                } => {
                    mode.delete_result(&message, tone, deleted_saved_path);
                    if shells_fetch_at.is_some() {
                        shells_fetch_at = Some(tokio::time::Instant::now());
                    }
                }
                UiInput::RenameResult { rename, outcome } => {
                    mode.rename_result(rename, outcome);
                }
                UiInput::HeadlineResult { key, result } => {
                    mode.headline_result(&key, result);
                }
                // The saved-resume's mid-send status lands between the resume and the
                // prompt like any set_status, never queued behind the result it
                // precedes.
                UiInput::ReplyProgress(text) => {
                    mode.set_status(&text);
                }
                UiInput::ReplyResult { key, outcome } => {
                    mode.reply_result(&key, outcome);
                }
                UiInput::KillResult { key, outcome } => {
                    mode.kill_result(&key, outcome);
                }
                // The saved-catalog scan landed: the Inactive section builds now.
                UiInput::SavedLoaded {
                    sessions,
                    more,
                    continued,
                } => {
                    // The final response is the authoritative array: a late frame must not upsert
                    // its un-enriched row over the catalog the response just settled.
                    mode.drop_saved_stream();
                    saved_flush = None;
                    catalog_request = None;
                    if continued {
                        mode.upsert_saved(sessions);
                    } else {
                        mode.apply_saved_loaded(sessions);
                    }
                    // The catalog's success retires the failure status (never keep reporting an
                    // unavailable catalog after it loaded).
                    if mode
                        .status_text()
                        .is_some_and(|status| status.starts_with("Saved sessions unavailable"))
                    {
                        mode.status = None;
                    }
                    mode.rebuild_rows();
                    mode.finish_saved_page(more);
                }
                UiInput::SavedFailed { error } => {
                    // The catalog settled on a terminal failure: the anchor's wait ends with it,
                    // the failure keeps the last good rows, and a late frame must not upsert.
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
                // Only the newest fetch applies (TS
                // `heartbeatCatalogGeneration`): responses can reorder.
                UiInput::HeartbeatsLoaded {
                    generation,
                    heartbeats,
                } => {
                    if generation == heartbeat_generation {
                        mode.heartbeats = heartbeats;
                    }
                }
                UiInput::PersistentShellsLoaded(data) => {
                    if let Some(data) = data {
                        mode.apply_persistent_shells(data);
                    }
                    shells_fetch_at = Some(
                        tokio::time::Instant::now() + crate::interactive::ACTIVITY_POLL_INTERVAL,
                    );
                }
                UiInput::PersistentShellTail {
                    id,
                    generation,
                    outcome,
                } => {
                    if let Some(view) = mode
                        .shell_view
                        .as_mut()
                        .filter(|view| view.detail_id().as_deref() == Some(id.as_str()))
                    {
                        match outcome {
                            Ok(tail) => view.set_output(&id, &tail, generation),
                            Err(error) => view.set_error(error, true, Some(generation)),
                        }
                    }
                }
                // A landed kill re-reads the list now unless a read is already in flight.
                UiInput::PersistentShellKilled { id, outcome } => match outcome {
                    Ok(()) => {
                        if shells_fetch_at.is_some() {
                            shells_fetch_at = Some(tokio::time::Instant::now());
                        }
                    }
                    Err(error) => {
                        if let Some(view) = mode
                            .shell_view
                            .as_mut()
                            .filter(|view| view.detail_id().as_deref() == Some(id.as_str()))
                        {
                            view.set_error(error, false, None);
                        }
                    }
                },
                UiInput::SessionActivityLoaded(reads) => {
                    mode.apply_session_activity(reads);
                    activity_fetch_at = Some(
                        tokio::time::Instant::now() + crate::interactive::ACTIVITY_POLL_INTERVAL,
                    );
                }
                // The headless plan ended: the run stops here (the
                // interactive harness's `HeadlessDone` contract). A plan
                // that ends without an exit key still captures its frames
                // and returns instead of spinning forever.
                UiInput::Done => mode.running = false,
            }
            // The bash view's keys and wheel scrolls queue its action: dispatch
            // it after the input has been applied.
            if let Some(action) = mode.pending_shell_action.take() {
                action_dispatches.extend(persistent_shells::spawn_action(
                    &client,
                    ui_tx.clone(),
                    action,
                ));
            }
            // An exit decision skips sync terminal I/O: a wedged pty must
            // not prevent the reader-armed force-quit deadline from firing.
            if !mode.running {
                break;
            }
            redraw = true;
        } else {
            // The batch window's and the status line's deadlines, copied out of the
            // loop state: select evaluates EVERY branch expression whether or not its
            // precondition passes, so the arms below must never unwrap an Option.
            let flush_at = saved_flush;
            let shells_at = shells_fetch_at;
            let status_at = mode.status_expiry(std::time::Instant::now());
            tokio::select! {
                    maybe_event = events.recv() => {
                        match maybe_event {
                            Some(DaemonClientEvent::RosterUpdate { changed, removed, resync }) => {
                                mode.apply_roster_update(changed, removed, resync);
                                redraw = true;
                            }
                            // The scan streams its rows: one rebuild per batch window, so
                            // the Inactive section appears progressively instead of after
                            // the whole scan.
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
                            // TS `heartbeats_changed` → `refreshHeartbeats`:
                            // the daemon-global broadcast re-reads the
                            // catalog; the landed answer redraws, not this.
                            Some(DaemonClientEvent::HeartbeatsChanged) => {
                                heartbeat_generation += 1;
                                heartbeats::spawn_heartbeat_catalog_fetch(
                                    &client,
                                    ui_tx.clone(),
                                    heartbeat_generation,
                                );
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
                    result = async {
                        match activity_fetch.as_mut() {
                            Some(fetch) => fetch.await,
                            None => std::future::pending().await,
                        }
                    } => {
                        activity_fetch = None;
                        if let Ok(reads) = result {
                            pending.push(UiInput::SessionActivityLoaded(reads));
                        } else {
                            activity_fetch_at = Some(
                                tokio::time::Instant::now() + crate::interactive::ACTIVITY_POLL_INTERVAL,
                            );
                        }
                        continue;
                    }
                    // Only a running row needs a periodic frame. The timer
                    // stays tied to the last pulse across unrelated inputs.
                    () = tokio::time::sleep_until(last_pulse + Duration::from_millis(PULSE_INTERVAL_MS)),
                        if mode.rows.iter().any(|row| row.section == Section::Running) => {}
                    // The streamed-catalog batch window: the buffered rows flush as one rebuild; a
                    // closed window pends forever.
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
                    () = async {
                        match shells_at {
                            Some(at) => tokio::time::sleep_until(at).await,
                            None => std::future::pending().await,
                        }
                    } => {
                        shells_fetch_at = None;
                        persistent_shells::spawn_list_fetch(&client, ui_tx.clone());
                    }
                    () = async {
                        match activity_fetch_at {
                            Some(at) => tokio::time::sleep_until(at).await,
                            None => std::future::pending().await,
                        }
                    } => {
                        activity_fetch_at = None;
                        activity_fetch = Some(session_activity::spawn_session_activity_fetch(
                            &client,
                            mode.live_session_ids(),
                        ));
                    }
                    // The incident-notice poll's wake-up: the drain below the select
                    // does the refresh, so the arm only ends the wait.
                    () = tokio::time::sleep_until(incident_poll_at) => {}
                    // The render barrier's deadline: an armed hold whose needle never lands
                    // still pops here, so a quiet daemon cannot wedge the loop.
                    () = async {
                        match wait_render_deadline {
                            Some(at) => tokio::time::sleep_until(at).await,
                            None => std::future::pending().await,
                        }
                    } => {}
                    // The status line's expiry wake: the line clears at its deadline
                    // even on a quiet view, and the expiry check below repaints it
                    // away.
                    () = async {
                        match status_at.map(tokio::time::Instant::from_std) {
                            Some(at) => tokio::time::sleep_until(at).await,
                            None => std::future::pending().await,
                        }
                    } => {}
                }
        }
        // The status line's timer: an expired line clears here after every arm, so
        // a status that aged out mid-batch never survives the redraw that follows.
        redraw |= mode.expire_status(std::time::Instant::now());
        // Coalesce a due animation pulse with the input or roster frame, and a due incident poll
        // behind a busy input stream.
        redraw |= advance_running_pulse(&mut mode, &mut last_pulse, tokio::time::Instant::now());
        if tokio::time::Instant::now() >= incident_poll_at {
            incident_poll_at = tokio::time::Instant::now()
                + Duration::from_millis(crate::incident_notices::INCIDENT_NOTICE_POLL_INTERVAL_MS);
            redraw |= mode.refresh_incident_notices();
        }
        // A failed saved-catalog fetch re-arms on the next query change or deferred shell open
        // (a key, a paste, or a click): one honest retry behind a terminal failure.
        if mode.take_saved_fetch_rearm() {
            catalog_request = Some(spawn_saved_catalog_fetch(
                &client,
                ui_tx.clone(),
                cwd.clone(),
                session_dir.clone(),
                None,
                Some(SAVED_CATALOG_PAGE_FILES),
            ));
            // A superseded fetch's stream stops applying: the new fetch owns the
            // catalog.
            mode.drop_saved_stream();
            saved_flush = None;
        }
        // The unfolded rest of the store: a scroll near the list's end fetches the next page, a
        // search fetches all of it (its rows stream in as they fold).
        if catalog_request.is_none() {
            if let Some((cursor, limit)) = mode.next_saved_fetch() {
                mode.saved_page_requested = false;
                catalog_request = Some(spawn_saved_catalog_fetch(
                    &client,
                    ui_tx.clone(),
                    cwd.clone(),
                    session_dir.clone(),
                    Some(cursor),
                    limit,
                ));
            }
        }
        if redraw {
            renderer.draw(&mut mode);
        }
    }

    // The view decided to leave. The force-quit deadline arms below,
    // after the stop-or-delete drain settles: a confirmed request
    // completes before any deadline can cut it down. `renderer.finish`
    // consumes the renderer, so the terminal check is read first.
    let handing_off = mode.opened.is_some();
    let terminal_exit = matches!(renderer, Renderer::Terminal { .. }) && !handing_off;
    // A selection hands the pane to the chat it opened (TS `result.type !== "exit"`);
    // exiting releases the alternate screen.
    let frames = renderer.finish(mode.opened.is_some());
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
    // A handoff retires the watchdog before the drain wait: a double-press must not force-quit a
    // process that is merely switching views.
    if handing_off {
        exit_guard.cancel();
    }
    // An in-flight stop-or-delete dispatch settles before the connection closes: an exit right
    // after the second ctrl+x must not drop the request.
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
            // The reply outcomes apply on the exit path too (an Enter-then-exit): the
            // statuses paint nothing on a run that ended, but the adoption actions
            // (`reply_sent`, `killed`) must still reach the outcome.
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
            UiInput::SessionActivityLoaded(reads) => {
                mode.apply_session_activity(reads);
            }
            _ => {}
        }
    }
    // The force-quit deadline arms only after the drain; a selection is a view switch, not an
    // exit, so the deadline covers only the leaves that end this process.
    if terminal_exit {
        exit_guard.arm_for_exit();
    }
    // A handoff returns the roster connection for the flow's next view run
    // (TS `persistentState.rosterClient`); a selection-less exit closes it.
    let link = if opened.is_some() {
        // The handoff link carries the catalog the run loaded (TS
        // `persistentState.savedSessions`/`savedCatalogLoaded`): the flow's
        // next view run paints the Inactive rows it already holds on its
        // first frame and skips the fetch when this one loaded them.
        Some(AgentsViewLink {
            client,
            events,
            saved: SavedCatalog {
                sessions: mode.saved.clone(),
                loaded: mode.saved_catalog_loaded,
                more: mode.saved_more.clone(),
            },
            session_activity: std::mem::take(&mut mode.session_activity),
            persistent_shells: std::mem::take(&mut mode.persistent_shells),
            activity_fetch,
        })
    } else {
        client.close();
        None
    };
    Ok(AgentsViewRun {
        link,
        outcome: AgentsViewOutcome {
            selection: opened.as_ref().map(|row| row.selection.clone()),
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
            panel: opened.as_ref().and_then(|row| row.panel.clone()),
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
/// saved catalog's landing (or its terminal failure), the heartbeat
/// catalog's landing, and the stop-or-delete dispatch results are the
/// events the plan's needles wait on — they must never queue behind the
/// hold they satisfy.
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
            | UiInput::HeartbeatsLoaded { .. }
            | UiInput::PersistentShellsLoaded(_)
            | UiInput::PersistentShellTail { .. }
            | UiInput::PersistentShellKilled { .. }
            | UiInput::SessionActivityLoaded(_)
    )
}

fn first_input(pending: &mut Vec<UiInput>) -> Option<UiInput> {
    if pending.is_empty() {
        None
    } else {
        Some(pending.remove(0))
    }
}

#[cfg(test)]
mod tests;
