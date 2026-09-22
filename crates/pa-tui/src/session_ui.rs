//! Live per-session UI state for the interactive loop: the daemon-client
//! side of one attached session — prompt submission, slash commands, streamed
//! event application, and session switching. Rendering itself lives in the
//! view crate modules; this module only decides what the view shows.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use pa_types::daemon::DaemonCommand;
use pa_types::slash_commands::{SlashCommandExecution, SlashCommandRegistry};
use serde_json::Value;

use crate::chat::{
    ChatEntry, CompactionReason, CompactionState, MessageBlock, RetryState, StatusKind,
    ToolResultView, WorkingState,
};
use crate::daemon_client::{DaemonClient, DaemonClientEvent};
use crate::effort_picker::{self, EffortPickerAction};
use crate::export_share::{self, GhAuthStatus, GistOutcome};
use crate::goal_surface::{format_goal_status, tray_goal_label, GoalView};
use crate::heartbeats_picker::{
    parse_heartbeats, scope_heartbeats, sort_heartbeats, HeartbeatAction, HeartbeatEntry,
    HeartbeatsPicker, HeartbeatsPickerAction,
};
use crate::image_load::LoadedImage;
use crate::image_markers::{
    collect_marked_images, evict_images_to_budget, format_image_marker, image_marker_ids,
};
use crate::info_commands;
use crate::interactive::{InteractiveOptions, ModelSelection, SessionSelection};
use crate::keys::key_event_to_id;
use crate::model_picker::{CurrentModel, ModelPicker, ModelPickerAction, ModelPickerOptions};
use crate::prompt_stash::PromptStash;
use crate::provider_auth::{AuthSelectorAction, AuthSelectorKind};
use crate::queued::{QueueBrowseDirection, QueueLane};
use crate::snapshot::{
    assistant_message_parts, attach_data_from_response, event_to_update, reconstruct, TurnUpdate,
};
use crate::tree_selector::{TreeSelector, TreeSelectorAction};
use crate::user_message_selector::{UserMessageSelector, UserMessageSelectorAction};
use crate::view::{AgentView, ShareLoader};

use crossterm::event::KeyEvent;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// How long the Ctrl+C exit hint arms the second-press exit (TS
/// `EXIT_HINT_DURATION_MS`).
const CTRL_C_EXIT_HINT_MS: u64 = 2_000;
/// TS `SELECTION_AUTO_SCROLL_DELAY_MS`: how long a drag must hold the
/// window edge before the auto-scroll starts.
const SELECTION_AUTO_SCROLL_DELAY: Duration = Duration::from_millis(150);
/// Cap on any daemon request awaited on the key-handling path: the UI loop
/// must stay responsive to Ctrl+C while a submission travels (the TS loop
/// never blocks on these — aborts are fire-and-forget, submissions resolve
/// off the render path).
const UI_REQUEST_TIMEOUT_MS: u64 = 10_000;

/// How long a fetched model catalog stays fresh (TS
/// `MODEL_CATALOG_REFRESH_TTL_MS`); a `/model` open past it refreshes
/// again in the background.
const MODEL_CATALOG_REFRESH_TTL: std::time::Duration = std::time::Duration::from_secs(60);
/// Cap on the detach request during the exit path: the client must exit
/// promptly even when the worker socket is wedged.
const EXIT_DETACH_TIMEOUT_MS: u64 = 600;
/// The double-Escape repeat window (TS `ESCAPE_REPEAT_WINDOW_MS`).
const ESCAPE_REPEAT_WINDOW_MS: std::time::Duration = std::time::Duration::from_millis(500);
/// Cap on the exit-path session-stats fetch (TS `formatResumeHint` inputs):
/// best-effort like the detach, never able to hold the exit open.
const EXIT_STATS_TIMEOUT_MS: u64 = 500;

/// How a submitted prompt travels to the session (TS `streamingBehavior`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubmitBehavior {
    /// Plain Enter: mid-turn input parks on the steering lane (TS "steer").
    Steer,
    /// The follow-up key (`alt+enter`): parks on the follow-up lane and
    /// delivers when the run goes idle.
    FollowUp,
}

/// Live UI state for one attached daemon session.
/// The `/share` upload task's report: the created gist or the failure
/// message (TS resolves the same promise from the gh process result).
pub(crate) type ShareNote = Result<GistOutcome, String>;

/// The `/reload` task's report: the daemon reloaded the session's live
/// inputs, or the failure message (TS `handleReloadCommand`'s outcome).
pub(crate) type ReloadNote = Result<(), String>;

/// A landed heartbeat-catalog refresh for the `/heartbeats` view (TS
/// `refreshHeartbeatCatalog`'s fetch result): the scoped, sorted rows or
/// the fetch error that replaces them.
pub(crate) struct HeartbeatsUpdate {
    pub heartbeats: Vec<HeartbeatEntry>,
    pub fetch_error: Option<String>,
}

/// A landed `get_model_catalog` refresh: the full catalog and the providers
/// with configured auth (TS `AgentConnectionModelCatalog`).
pub(crate) struct ModelCatalogUpdate {
    pub models: Vec<pa_types::ai::Model>,
    pub configured_providers: std::collections::HashSet<String>,
}

/// A `/share` upload in flight: the abortable task and the temp export.
pub(crate) struct ShareRun {
    /// The upload task; aborting it kills `gh` (`kill_on_drop`).
    task: tokio::task::JoinHandle<()>,
    /// The temp HTML export `gh gist create` uploads (removed on settle).
    tmp_file: std::path::PathBuf,
}

/// TS status notes: the mutation status vocabulary (`applied`, `rejected`,
/// `invalid`, `unsupported`) maps to the TS status rows; `is_edit` picks the
/// edit phrasing over the reorder phrasing.
fn queue_mutation_status_note(status: &str, is_edit: bool) -> String {
    match status {
        "invalid" => {
            "Edited command is not a valid session command; edit kept in the editor".to_string()
        }
        "unsupported" => "Queue editing requires a newer daemon".to_string(),
        _ if is_edit => "Queue changed; edit kept in the editor".to_string(),
        _ => "Queue changed; reorder not applied".to_string(),
    }
}

/// The question a pending confirm answers (TS `showExtensionConfirm`
/// callers await inline; the TUI loop parks the continuation instead).
#[derive(Debug, Clone, PartialEq, Eq)]
enum PendingConfirm {
    /// `/import <path>`: replace the current session with the JSONL file.
    Import { path: String },
    /// The import's stored session cwd is gone: `Yes` retries with the
    /// fallback cwd (TS `promptForMissingSessionCwd`).
    ImportCwdFallback { path: String, fallback_cwd: String },
}

pub(crate) struct SessionUi {
    pub(crate) client: DaemonClient,
    pub(crate) active_session_id: String,
    pub(crate) session_id: String,
    session_name: Option<String>,
    /// Config carried over from the run options; `/new` sessions reuse it.
    cwd: PathBuf,
    session_dir: Option<PathBuf>,
    script_path: Option<PathBuf>,
    model_selection: ModelSelection,
    /// The model catalog for the `/model` picker: a startup snapshot from
    /// the composition root (the bundled fallback), replaced by the
    /// daemon's `get_model_catalog` response once it lands.
    model_catalog: Vec<pa_types::ai::Model>,
    /// Providers with configured auth (the daemon catalog's
    /// `configuredProviders`); the picker marks the rest "require sign in".
    model_configured_providers: std::collections::HashSet<String>,
    /// The settings recent-model list (`provider/id` keys, newest first).
    model_recent_models: Vec<String>,
    /// The settings default thinking level (TS `getDefaultThinkingLevel`)
    /// — the picker's effort seed for non-reasoning current models.
    default_thinking_level: Option<String>,
    /// When the daemon catalog was last refreshed (TS
    /// `connectionModelsFetchedAt`; the refresh is TTL-gated).
    models_fetched_at: Option<std::time::Instant>,
    /// Pasted images held for their editor markers, keyed by marker id
    /// (TS `pastedImages`). Insertion order is paste order.
    pasted_images: std::collections::BTreeMap<u64, LoadedImage>,
    /// The next `[image #N]` marker id (TS `nextImageMarkerId`).
    next_image_marker_id: u64,
    /// Telemetry opt-out carried over from the run options; every attach to
    /// another session keeps carrying it (TS attach parity).
    telemetry_disabled: Option<bool>,
    /// The chat markdown fenced-code indent from the run's options
    /// (`markdown.codeBlockIndent`); `/new` re-opens with the same value
    /// instead of resetting it to the default.
    code_block_indent: String,
    /// The `/tree` selector's initial filter mode (the `treeFilterMode`
    /// setting).
    tree_filter_mode: crate::tree_list::FilterMode,
    /// The `branchSummary.skipPrompt` setting: navigation skips the
    /// summarize question.
    branch_summary_skip_prompt: bool,
    /// The transcript index of the last `note` status row (TS `showStatus`
    /// tracks its previous row for the back-to-back in-place rewrite; any
    /// later entry invalidates it through the length check).
    last_status_index: Option<usize>,
    /// The `terminal.showImages` setting, carried into `/new` runs.
    show_images: bool,
    /// The `terminal.fullscreenMouse` setting: whether the interactive
    /// surface enables mouse tracking; carried into `/new` runs.
    fullscreen_mouse: bool,
    /// The runtime fullscreen flag (`/fullscreen`, TS `fullscreenEnabled`):
    /// this surface always renders on the alternate screen, so the flag
    /// starts on and the command persists the preference (TS
    /// `settingsManager.setFullscreen`) and reports the TS status.
    fullscreen_enabled: bool,
    /// The session's effective service tier (TS `connectionState.serviceTier`),
    /// seeded from the attach state and kept live by `service_tier_changed`
    /// events; the `/fast` toggle reads it.
    service_tier: Option<String>,
    /// The client-process settings seam (`/settings`, `/fullscreen`);
    /// the composition root supplies it.
    client_settings: Option<std::sync::Arc<dyn crate::client_settings::ClientSettings>>,
    /// The side-question run currently streaming (TS `activeSideQuestionId`):
    /// at most one run per client, exactly like the daemon enforces.
    active_side_question_id: Option<String>,
    /// The next side-question local id suffix (the daemon only requires
    /// per-client uniqueness).
    side_question_counter: u64,
    /// A `/share` gist upload in flight (TS `BorderedLoader` + the gh
    /// spawn): aborting the task kills `gh` (kill-on-drop).
    share: Option<ShareRun>,
    /// Where the upload task reports its outcome (the run loop folds it
    /// into the transcript).
    share_notes: mpsc::UnboundedSender<ShareNote>,
    /// A `/reload` in flight (the reload box replaces the editor while
    /// the request travels).
    reload: Option<tokio::task::JoinHandle<()>>,
    /// Where the reload task reports its outcome.
    reload_notes: mpsc::UnboundedSender<ReloadNote>,
    /// Where the background catalog refresh delivers `get_model_catalog`
    /// responses (the run loop folds them into the picker catalog).
    catalog_updates: mpsc::UnboundedSender<ModelCatalogUpdate>,
    /// Where background heartbeat-catalog refreshes deliver their fetches
    /// (the run loop folds them into an open `/heartbeats` view).
    heartbeat_updates: mpsc::UnboundedSender<HeartbeatsUpdate>,
    /// Snapshot chat entries to fold into the view on the next rebuild.
    pending_snapshot: Option<Vec<ChatEntry>>,
    /// Snapshot labels (model) for the next rebuild.
    pending_model: Option<String>,
    /// Snapshot queue state for the next rebuild (attach re-sync).
    pending_queue: Option<crate::queued::QueuedMessages>,
    /// The parked-message browse state (TS `QueueSelection`): which queued
    /// row alt+up/alt+down selected, and its stashed editor draft.
    queue_selection: crate::queued::QueueSelection,
    /// Context usage + cost refreshed from `get_session_stats`.
    context: Option<crate::chrome::ContextUsage>,
    cost_usd: Option<f64>,
    /// Rows of the most recent `/list` (for `/switch <n>`).
    list_rows: Vec<Value>,
    pub(crate) turn_active: bool,
    /// The chat index of the assistant message still streaming.
    streaming_index: Option<usize>,
    /// The loader's token accounting (TS `AgentActivityTracker`), reported
    /// monotonically within a run.
    working_tokens: LoaderTokenTracker,
    /// The turn already surfaced its error (a failed assistant message or a
    /// retry-exhausted banner); the turn_end error stays silent then (TS
    /// renders the failure once, through the message or the retry banner).
    turn_error_shown: bool,
    pub(crate) last_assistant_text: Option<String>,
    /// The OSC 52 channel for clipboard writes (TS `process.stdout`):
    /// stdout in the terminal, a captured buffer in headless runs.
    pub(crate) osc_sink: crate::clipboard::OscSink,
    /// The question the open confirm panel answers (TS `showExtensionConfirm`).
    pending_confirm: Option<PendingConfirm>,
    /// `/traces`: the settings + credential state the composition root
    /// owns (the trace upload subsystem itself stays unported).
    traces: Option<crate::traces::TracesCommandsHandle>,
    /// `/login` + `/logout`: the provider auth flows the composition root
    /// owns (credential storage, OAuth flows, the provider catalog).
    provider_auth: Option<crate::provider_auth::ProviderAuthCommandsHandle>,
    /// A provider login that needs the plain terminal (browser OAuth /
    /// the MCP device flow): the run loop hands the terminal over and
    /// runs this row's flow.
    pending_terminal_login: Option<crate::provider_auth::ProviderRow>,
    /// A `/update` run parked for the run loop: the child processes need
    /// the plain terminal, and a successful self-update replaces this
    /// process with the updated CLI.
    pending_update: Option<crate::update_command::UpdatePlan>,
    /// `/update`: the child runner + relaunch the composition root owns.
    update_commands: Option<crate::update_command::UpdateCommandsHandle>,
    pub(crate) exit_requested: bool,
    /// `/resume` or the agents-back key: reopen the agents view after this
    /// session detaches.
    pub(crate) open_agents_view: bool,
    /// The subagent summary line opened the scoped agents view: the scope
    /// the view opens on (this session's subtree).
    pub(crate) scoped_agents_view: Option<crate::agents_view::AgentsViewScope>,
    /// The live agent roster (the session view's `roster_subscribe`
    /// subscription, TS `rosterBar`): drives the subagent summary counts.
    roster: Vec<Value>,
    /// The scoped heartbeat catalog (TS `heartbeatCatalog` over
    /// `getScopedHeartbeats`): drives the tray heartbeat label and seeds
    /// the `/heartbeats` view; refreshed by `heartbeats_changed`.
    heartbeat_catalog: Vec<HeartbeatEntry>,
    /// The subagent summary line holds keyboard focus.
    subagents_focused: bool,
    /// The last computed descendant counts (selectability reads them between
    /// roster updates).
    subagent_counts: crate::subagents::SubagentCounts,
    /// This session's persisted file path (family identity of the
    /// subagent linkage; `None` for unpersisted sessions).
    session_file: Option<String>,
    /// `/resume <selector>`: open this selection next (the run returns it).
    pub(crate) pending_selection: Option<SessionSelection>,
    /// Whether this run may hand the terminal back to the agents view (TS
    /// `returnToAgentsView`): true for every daemon-hosted session, false
    /// only for `--no-session` runs.
    pub(crate) return_to_agents_view: bool,
    /// `/mcp login` / `/mcp logout` (the composition root's auth flows).
    client_auth: Option<crate::client_auth::ClientAuthCommandsHandle>,
    /// The effective keybindings (user `keybindings.json` over the TS
    /// defaults): hint labels and app-level handlers dispatch through this
    /// set, and `/new` runs carry it forward.
    keybindings: crate::keybindings::KeybindingsManager,
    /// The process-wide prompt stash store (TS `ClientPromptStashStore`),
    /// owned by the composition root and shared by every chat view of this
    /// TUI process.
    prompt_stash: std::sync::Arc<std::sync::Mutex<crate::prompt_stash::PromptStashStore>>,
    /// The stable session id the prompt stash state is bound to (TS
    /// `promptStashSessionId`).
    stash_session_id: String,
    pub(crate) dirty: bool,
    /// The Ctrl+C exit hint (TS `ctrlCExitHintExpiresAt`): a second press
    /// inside the window terminates the client, regardless of turn state.
    ctrl_c_hint_until: Option<Instant>,
    /// The session's thread-goal view state (current `goal_update` state,
    /// announcement dedupe, tray label bookkeeping).
    pub(crate) goal_view: GoalView,
    /// Notes surfacing from background tasks (the async abort result) into
    /// the UI loop.
    notes: mpsc::UnboundedSender<String>,
    /// A succeeded compaction replaced the durable transcript (TS
    /// `rebuildChatFromMessages`): the next loop pass re-fetches it.
    pub(crate) transcript_stale: bool,
    /// Adoption telemetry (`tui scroll used` / `tui exit`); `None` drops
    /// events.
    pub(crate) telemetry: Option<std::sync::Arc<dyn crate::interactive::InteractionTelemetry>>,
    /// Whether this run already reported its first scroll action.
    scroll_adoption_emitted: bool,
    /// How the client run ended (the `tui exit` reason).
    pub(crate) exit_reason: &'static str,
    /// The §10 reattach contract: set when a `daemon_closing` update frame
    /// arrived; the interactive loop drives the reconnect from it.
    pub(crate) reconnect: Option<crate::daemon_client::DaemonClosingUpdate>,
    /// The session whose direct worker link just died; the interactive
    /// loop arms the re-attach driver from it (TS `connection_status:
    /// "reconnecting"`).
    pub(crate) transport_lost: Option<String>,
    /// The re-attach window expired (TS terminal close after
    /// `DAEMON_RECONNECT_TIMEOUT_MS`): dispatch is blocked and submits
    /// surface the error instead of leaving the UI on a silent spinner.
    pub(crate) reconnection_failed: Option<String>,
    /// The double-Ctrl+C force-quit guard (the run's shared instance is
    /// installed by the interactive loop after `open`).
    pub(crate) exit_guard: crate::exit_guard::ExitGuard,
    /// The armed double-Escape action (TS `escapeRepeatAction`): "tree" or
    /// "clear", taken by the second press inside the 500ms window.
    escape_repeat_action: Option<&'static str>,
    escape_repeat_until: Option<Instant>,
    /// The `!`/`!!` user-bash lane (TS interactive-mode onSubmit): the
    /// client-side running flag (optimistic on submit, patched by the
    /// `bash_start`/`bash_end` events), the mounted transcript card id,
    /// and the raw output the streamed chunks accumulated for its fold.
    user_bash_running: bool,
    user_bash_card: Option<String>,
    user_bash_output: String,
    user_bash_counter: u64,
    /// An in-flight side-conversation bash run (TS `sideQuestionBash`):
    /// its pane-mounted identity plus whether the run seeds follow-up
    /// side questions (the `!`, not the `!!`, variant).
    side_bash: Option<SideBashRun>,
    /// A discarded side-bash run whose `bash_*` events are swallowed
    /// until its own `bash_end` (TS `sideQuestionBashDiscarded`).
    side_bash_discarded: Option<String>,
    /// The next side-bash run id (TS `randomUUID`; a client-local counter
    /// is enough identity for event matching).
    side_bash_counter: u64,
    /// `app.suspend` (default ctrl+z, TS `handleCtrlZ`) requested the
    /// process-group suspend: the interactive loop performs the cycle
    /// right after dispatch, because the renderer is the loop's terminal.
    suspend_requested: bool,
    /// A client command a selector resolved to (the `/mcp` view's Enter:
    /// TS `authenticate` runs the login flow): the interactive loop
    /// dispatches it through the ordinary submit path right after the key,
    /// so the terminal-suspending auth flows keep their bracket.
    pending_client_command: Option<String>,
    /// Whether this run already reported its first suspend cycle.
    suspend_adoption_emitted: bool,
    /// The armed selection auto-scroll (TS `selectionAutoScroll*`): a drag
    /// holding the pointer at the window edge scrolls the transcript while
    /// it lasts.
    selection_auto_scroll: Option<SelectionAutoScroll>,
    /// Whether this run already reported its first selection copy.
    selection_adoption_emitted: bool,
    /// Texts copied out by finished selections this run (headless runs
    /// have no terminal to write OSC 52 to; the verifier reads these).
    pub(crate) copies: Vec<String>,
}

/// One in-flight side-conversation bash run (TS `sideQuestionBash`): the
/// `runId` the daemon echoes on the run's `bash_*` events, the raw input
/// (`!command`) that seeded it, and whether its output seeds follow-up
/// side questions (the `!`, not the `!!`, variant).
#[derive(Debug, Clone)]
struct SideBashRun {
    run_id: String,
    input: String,
    seed_transcript: bool,
}

/// One armed auto-scroll (TS `selectionAutoScrollTimer` state): the drag's
/// last position and when the scroll window opened.
#[derive(Debug, Clone)]
struct SelectionAutoScroll {
    direction: isize,
    row: usize,
    col: usize,
    started: Instant,
}

impl SessionUi {
    /// Create/attach per the session selection and return the live state.
    pub(crate) async fn open(
        client: DaemonClient,
        options: &InteractiveOptions,
        notes: mpsc::UnboundedSender<String>,
        share_notes: mpsc::UnboundedSender<ShareNote>,
        reload_notes: mpsc::UnboundedSender<ReloadNote>,
        catalog_updates: mpsc::UnboundedSender<ModelCatalogUpdate>,
        heartbeat_updates: mpsc::UnboundedSender<HeartbeatsUpdate>,
    ) -> Result<SessionUi> {
        let active_session_id = match &options.session {
            SessionSelection::New => create_session(&client, options, None).await?,
            SessionSelection::Attach(id) => id.clone(),
            SessionSelection::ContinueRecent | SessionSelection::Resume(_) => {
                create_session(&client, options, Some(&options.session)).await?
            }
        };
        let mut session = SessionUi {
            client,
            active_session_id: String::new(),
            session_id: String::new(),
            session_name: None,
            cwd: options.cwd.clone(),
            session_dir: options.session_dir.clone(),
            script_path: options.script_path.clone(),
            model_selection: options.model_selection.clone(),
            model_catalog: options.model_catalog.clone(),
            model_configured_providers: options.model_configured_providers.clone(),
            model_recent_models: options.model_recent_models.clone(),
            default_thinking_level: options.default_thinking_level.clone(),
            models_fetched_at: None,
            catalog_updates,
            heartbeat_updates,
            telemetry_disabled: options.telemetry_disabled,
            code_block_indent: options.code_block_indent.clone(),
            tree_filter_mode: crate::tree_list::filter_mode_from_str(&options.tree_filter_mode),
            branch_summary_skip_prompt: options.branch_summary_skip_prompt,
            last_status_index: None,
            show_images: options.show_images,
            fullscreen_mouse: options.fullscreen_mouse,
            fullscreen_enabled: options
                .client_settings
                .as_ref()
                .map(|settings| settings.fullscreen())
                .unwrap_or(true),
            service_tier: None,
            client_settings: options.client_settings.clone(),
            active_side_question_id: None,
            side_question_counter: 0,
            share: None,
            reload: None,
            reload_notes,
            share_notes,
            pasted_images: Default::default(),
            next_image_marker_id: 1,
            pending_snapshot: None,
            pending_model: None,
            pending_queue: None,
            queue_selection: crate::queued::QueueSelection::default(),
            context: None,
            cost_usd: None,
            list_rows: Vec::new(),
            turn_active: false,
            streaming_index: None,
            working_tokens: LoaderTokenTracker::default(),
            turn_error_shown: false,
            last_assistant_text: None,
            osc_sink: crate::clipboard::OscSink::Stdout,
            pending_confirm: None,
            traces: options.traces.clone(),
            provider_auth: options.provider_auth.clone(),
            pending_terminal_login: None,
            pending_update: None,
            update_commands: options.update_commands.clone(),
            exit_requested: false,
            open_agents_view: false,
            scoped_agents_view: None,
            roster: Vec::new(),
            heartbeat_catalog: Vec::new(),
            subagents_focused: false,
            subagent_counts: crate::subagents::SubagentCounts::default(),
            session_file: None,
            pending_selection: None,
            return_to_agents_view: !options.no_session,
            client_auth: options.client_auth.clone(),
            keybindings: options.keybindings.clone(),
            prompt_stash: options.prompt_stash.clone(),
            stash_session_id: String::new(),
            dirty: true,
            ctrl_c_hint_until: None,
            goal_view: GoalView::new(),
            notes,
            transcript_stale: false,
            telemetry: options.telemetry.clone(),
            scroll_adoption_emitted: false,
            exit_reason: "daemon_closed",
            reconnect: None,
            transport_lost: None,
            reconnection_failed: None,
            exit_guard: crate::exit_guard::ExitGuard::new(),
            escape_repeat_action: None,
            escape_repeat_until: None,
            user_bash_running: false,
            user_bash_card: None,
            user_bash_output: String::new(),
            user_bash_counter: 0,
            side_bash: None,
            side_bash_discarded: None,
            side_bash_counter: 0,
            suspend_requested: false,
            pending_client_command: None,
            suspend_adoption_emitted: false,
            selection_auto_scroll: None,
            selection_adoption_emitted: false,
            copies: Vec::new(),
        };
        session
            .attach_session(&active_session_id)
            .await
            .with_context(|| format!("attaching session {active_session_id}"))?;
        Ok(session)
    }

    /// Spec §10.2-§10.5: reattach after an update restart. The fresh client
    /// (connected to the successor supervisor) replaces the dead one; the
    /// attach goes by DURABLE session id, so the slice-5 queued-attach
    /// contract absorbs any restore still in flight (the §10.3 hello's
    /// `update_resume.complete` is surfaced as a banner line). The
    /// transcript rebuilds from the attach snapshot - the same machinery
    /// `/switch` uses - and the resumed-work banner lands after it.
    pub(crate) async fn reattach_after_update(
        &mut self,
        client: DaemonClient,
        view: &mut AgentView,
    ) -> Result<()> {
        let hello_resume = client
            .hello()
            .get("updateResume")
            .cloned()
            .unwrap_or(Value::Null);
        let complete = hello_resume.get("complete").and_then(Value::as_bool);
        let update_id = hello_resume
            .get("updateId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.client = client;
        let durable = self.session_id.clone();
        if durable.is_empty() {
            anyhow::bail!("the session's durable id is unknown; cannot reattach");
        }
        self.attach_session(&durable)
            .await
            .with_context(|| format!("reattaching session {durable} after the update"))?;
        // Flush the attach snapshot BEFORE the banner lands: `rebuild_view`
        // replaces the transcript from the snapshot, so the banner must come
        // after it to survive the rebuild (§10.5's visible end state).
        self.rebuild_view(view);
        match complete {
            Some(false) => view.push_entry(crate::chat::ChatEntry::Status {
                text: "Reconnected — the daemon is finishing its restore; queued work resumes when the session comes up.".to_string(),
                kind: crate::chat::StatusKind::Info,
            }),
            _ => view.push_entry(crate::chat::ChatEntry::Status {
                text: format!(
                    "Reconnected to Prime Agent (update {update_id}) — your session and queued work resumed."
                ),
                kind: crate::chat::StatusKind::Info,
            }),
        }
        self.dirty = true;
        Ok(())
    }

    /// Detach the current session and attach `id`, rebuilding the transcript
    /// from the slim attach snapshot.
    ///
    /// The attach itself travels over a direct worker link when the
    /// supervisor issues a ticket (best effort: every failure keeps the
    /// supervisor-routed path, and a failed direct attach retries once over
    /// the supervisor).
    pub(crate) async fn attach_session(&mut self, active_session_id: &str) -> Result<()> {
        let previous = self.active_session_id.clone();
        if !previous.is_empty() && previous != active_session_id {
            let _ = self.detach().await;
        }
        // A direct link is bound to one session: drop it when switching.
        if self
            .client
            .direct_session_id()
            .is_some_and(|direct| direct != active_session_id)
        {
            self.client.drop_direct();
        }
        let attach_command = |session_id: &str| DaemonCommand::Attach {
            id: None,
            active_session_id: session_id.to_string(),
            supports_extension_ui: None,
            client_id: None,
            capabilities: None,
            resume_cursor: None,
            telemetry_disabled: self.telemetry_disabled.filter(|disabled| *disabled),
            recovery_config: None,
            env: None,
            launch_env: None,
            rest: Default::default(),
        };
        let direct_attached = self
            .client
            .upgrade_direct(active_session_id)
            .await
            .unwrap_or(false);
        let attached = match self
            .client
            .request_ok(attach_command(active_session_id))
            .await
        {
            Ok(data) => data,
            Err(error) => {
                if !direct_attached {
                    return Err(error);
                }
                // The direct attach failed: one supervisor-routed retry
                // (TS `DaemonAgentConnection.attach` fallback).
                self.client.drop_direct();
                self.client
                    .request_ok(attach_command(active_session_id))
                    .await?
            }
        };
        let data = attached;
        let attach = attach_data_from_response(&data)?;
        let reconstructed = reconstruct(&attach);
        self.active_session_id = attach.active_session_id;
        self.session_id = reconstructed.session_id;
        self.session_name = reconstructed.session_name.clone();
        self.service_tier = reconstructed.service_tier.clone();
        self.session_file = attach
            .snapshot
            .get("state")
            .and_then(|state| state.get("sessionFile"))
            .and_then(Value::as_str)
            .filter(|file| !file.is_empty())
            .map(str::to_string);
        // The subagent summary follows the fresh session's family: the old
        // roster belongs to the previous session, and the focus returns to
        // the editor (TS `resetSubagentSummary` on rebind).
        self.roster.clear();
        self.subagents_focused = false;
        self.subscribe_roster().await;
        // The heartbeat catalog is scoped to the session: drop the old
        // session's rows and fetch fresh ones in the background (TS
        // refreshes the catalog on every chat open).
        self.heartbeat_catalog.clear();
        self.spawn_heartbeat_refresh();
        self.pending_model = reconstructed.model_id;
        self.last_assistant_text = reconstructed
            .chat
            .iter()
            .rev()
            .find_map(|entry| match entry {
                ChatEntry::Assistant(message) => {
                    message.blocks.iter().rev().find_map(|block| match block {
                        MessageBlock::Text(text) => Some(text.clone()),
                        _ => None,
                    })
                }
                _ => None,
            });
        self.pending_queue = Some(reconstructed.queued);
        self.pending_snapshot = Some(reconstructed.chat);
        self.goal_view.seed(reconstructed.goal.unwrap_or_default());
        // The resynced state owns the loader (TS `renderResyncedSession`
        // rebuilds from the snapshot): a turn that is still live behind the
        // re-attach keeps the spinner, one that died with the old link (or
        // never ran) does not.
        let streaming = attach
            .snapshot
            .get("state")
            .map(|state| {
                ["isStreaming", "isCompacting"]
                    .iter()
                    .any(|flag| state.get(flag).and_then(Value::as_bool).unwrap_or(false))
            })
            .unwrap_or(false);
        self.turn_active = streaming;
        self.streaming_index = None;
        // TS `applyConnectionStateSnapshot` -> `bindPromptStashSession`: the
        // stash state follows the stable id of the session now rendered.
        // The initial attach and every in-place switch (`/switch`, `/new`)
        // rebind through here; a rebind hydrates the session's stashed
        // images into the paste registry.
        let stash_session_id = self.session_id.clone();
        self.bind_prompt_stash_session(&stash_session_id);
        Ok(())
    }

    /// Subscribe this client to the live agent roster (TS
    /// `subscribeAgentRoster`): the snapshot seeds the subagent summary
    /// counts, `roster_update` pushes keep them live. A failed
    /// subscription degrades to no counts (TS `rosterBar = undefined`).
    async fn subscribe_roster(&mut self) {
        let snapshot = self
            .client
            .request(DaemonCommand::RosterSubscribe {
                id: None,
                rest: Default::default(),
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
    }

    /// Recompute the subagent summary box from the roster (TS
    /// `updateSubagentSummaryLine`): live counts over this session's
    /// descendants, focused when the summary line holds the focus.
    fn update_subagent_summary(&mut self, view: &mut AgentView) {
        let identity = crate::subagents::SessionIdentity::new(
            (!self.active_session_id.is_empty()).then(|| self.active_session_id.clone()),
            (!self.session_id.is_empty()).then(|| self.session_id.clone()),
            self.session_file.clone(),
        );
        let counts = crate::subagents::count_descendants(&self.roster, &identity);
        self.subagent_counts = counts;
        if counts.total == 0 {
            self.subagents_focused = false;
            view.chrome.subagents = None;
            return;
        }
        view.chrome.subagents = Some(crate::chrome::SubagentSummary {
            running: counts.running,
            idle: counts.idle,
            inactive: counts.inactive,
            focused: self.subagents_focused,
            openable: self.return_to_agents_view,
        });
    }

    /// Whether the subagent summary line may take focus (TS `isSelectable`):
    /// children exist and the run can open the scoped agents view.
    fn subagents_selectable(&self) -> bool {
        self.return_to_agents_view && self.subagent_counts.total > 0
    }

    /// Hand the focus to the subagent summary line (TS
    /// `focusSubagentSummary`, shared by `app.subagents.focus` and the
    /// editor's move-below-prompt hook): the tray override label blocks
    /// the hand-off — the armed Ctrl+C exit hint, and the streaming
    /// follow-up-queue hint while a draft sits in the editor (TS
    /// `getTrayOverrideLabel`) — and a non-selectable line never takes
    /// it. The inline pickers never reach this point: they own the whole
    /// key dispatch before the editor path (TS `isInlinePickerOpen`).
    fn focus_subagents_summary(&mut self, view: &mut AgentView) -> bool {
        if self.tray_override().is_some()
            || (self.turn_active && !view.editor.get_text().trim().is_empty())
            || !self.subagents_selectable()
        {
            return false;
        }
        self.subagents_focused = true;
        self.update_subagent_summary(view);
        true
    }

    /// Open the scoped agents view from the focused summary line (TS
    /// `openScopedAgentsView` -> `returnToAgentsView("scoped_agents_view")`):
    /// the session detaches and the agents view reopens scoped to this
    /// session's subtree, anchored on it.
    fn open_scoped_agents_view(&mut self, view: &mut AgentView) {
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

    /// Fold the pending snapshot into the view (fresh transcript, footer
    /// labels). Called after attach and after every session switch.
    pub(crate) fn rebuild_view(&mut self, view: &mut AgentView) {
        view.clear_chat();
        // The rebuilt transcript invalidates the tracked status row.
        self.last_status_index = None;
        if let Some(items) = self.pending_snapshot.take() {
            for entry in items {
                view.push_entry(entry);
            }
        }
        if let Some(model) = self.pending_model.take() {
            view.chrome.model_id = Some(model);
        }
        view.queued = self.pending_queue.take().unwrap_or_default();
        // A rebuilt view starts from the snapshot's queue: any browse
        // selection belonged to the previous queue and drops (TS
        // `resetCurrentSessionRenderState` clears the selection).
        let _ = self.queue_selection.reset();
        view.queue_selected = None;
        view.chrome.chat_name = self.session_display();
        view.chrome.context = self.context;
        view.chrome.cost_usd = self.cost_usd;
        self.update_subagent_summary(view);
        // The rebuilt transcript invalidates the announcement row tracking;
        // the goal state itself carries over (seeded at attach).
        self.goal_view.reset_row_tracking();
        self.sync_goal_tray(view);
        self.sync_heartbeat_tray(view);
        // The rebuilt chat follows the session's live state: an attached
        // turn that survived the re-attach keeps its loader (TS
        // `renderResyncedSession`), and no stale loader survives a rebuild.
        if self.turn_active {
            self.start_loader(view);
        } else {
            view.working = None;
        }
        view.follow();
        self.update_fast_filter(view);
        self.dirty = true;
    }

    /// Materialize parked editor autocomplete requests once the input
    /// queue drains (the editor defers dropdown materialization past the
    /// keystroke batch; TS resolves suggestions asynchronously). The
    /// single-item Tab auto-apply mutates the editor text, so the change
    /// events dispatch here.
    pub(crate) fn materialize_editor_autocomplete(&mut self, view: &mut AgentView) {
        let was_showing = view.editor.is_showing_autocomplete();
        view.editor.materialize_autocomplete();
        for event in view.editor.take_events() {
            if let crate::editor::EditorEvent::Changed(text) = event {
                // TS onChange: the exit hint clears as soon as the editor
                // carries text.
                if !text.is_empty() {
                    self.clear_ctrl_c_hint();
                }
                self.dirty = true;
            }
        }
        if view.editor.is_showing_autocomplete() != was_showing {
            self.dirty = true;
        }
    }

    /// One `goal_update` session event (TS `handleGoalUpdate`): store the
    /// state, announce as a status row when the dedupe rules say so, and
    /// sync the tray goal label.
    fn apply_goal_update(&mut self, goal: Value, view: &mut AgentView) {
        let Ok(goal) = serde_json::from_value::<pa_types::goal::GoalState>(goal) else {
            return;
        };
        let announce = self.goal_view.apply_update(goal);
        if announce {
            self.announce_goal_status(view);
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

    /// The tray goal label follows the current goal state (TS
    /// `syncGoalTray`; the label itself is `getTrayGoalLabel`).
    pub(crate) fn sync_goal_tray(&mut self, view: &mut AgentView) {
        let label = tray_goal_label(&self.goal_view.goal);
        if view.chrome.goal_label != label {
            view.chrome.goal_label = label;
            self.dirty = true;
        }
    }

    fn session_display(&self) -> String {
        self.session_name
            .clone()
            .unwrap_or_else(|| crate::chrome::display_name(&self.cwd.to_string_lossy()))
    }

    /// Refresh context usage and session spend from `get_session_stats`
    /// (the TS tray's connection refresh): tokens, context window, percent,
    /// and the branch total cost.
    pub(crate) async fn refresh_stats(&mut self) {
        let Ok(data) = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetSessionStats {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Default::default(),
                },
            )
            .await
        else {
            return;
        };
        // TS `patchConnectionState` REPLACES the context usage snapshot:
        // unknown usage (tokens null right after a compaction, or a
        // response without the field) clears the tray display instead of
        // keeping the stale one.
        self.context = data.get("contextUsage").and_then(|usage| {
            let tokens = usage.get("tokens").and_then(Value::as_u64)?;
            let window = usage.get("contextWindow").and_then(Value::as_u64)?;
            Some(crate::chrome::ContextUsage {
                tokens,
                context_window: window,
            })
        });
        self.cost_usd = data.get("cost").and_then(Value::as_f64);
        self.dirty = true;
    }

    /// Re-apply the refreshed context usage and cost to the chrome state.
    pub(crate) fn rebuild_tray(&mut self, view: &mut AgentView) {
        view.chrome.context = self.context;
        view.chrome.cost_usd = self.cost_usd;
        view.chrome.chat_name = self.session_display();
        self.dirty = true;
    }

    pub(crate) fn note(&mut self, text: &str, view: &mut AgentView) {
        self.note_as(text, StatusKind::Info, view);
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

    /// The OSC 52 sequences the headless run captured (TS writes them to
    /// stdout; headless verification reads them here).
    pub(crate) fn take_osc_emissions(&mut self) -> Vec<String> {
        match std::mem::replace(&mut self.osc_sink, crate::clipboard::OscSink::Stdout) {
            crate::clipboard::OscSink::Buffer(buffer) => {
                vec![String::from_utf8_lossy(&buffer).into_owned()]
            }
            crate::clipboard::OscSink::Stdout => Vec::new(),
        }
    }

    pub(crate) async fn detach(&self) -> Result<()> {
        self.bounded_request(
            Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
            DaemonCommand::Detach {
                id: None,
                active_session_id: Some(self.active_session_id.clone()),
                rest: Default::default(),
            },
        )
        .await
        .map(|_| ())
    }

    /// Detach on the agents-view handoff without blocking it: the request
    /// goes on the wire immediately and a background task owns the
    /// connection until the daemon answers (or the exit cap fires), then
    /// closes it. Attached-client bookkeeping must not delay the switch;
    /// the supervisor also detaches this client when the socket closes, so
    /// the response is not a handoff dependency.
    pub(crate) fn detach_for_handoff(&self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(
                Duration::from_millis(EXIT_DETACH_TIMEOUT_MS),
                client.request_ok(DaemonCommand::Detach {
                    id: None,
                    active_session_id: Some(active_session_id),
                    rest: Default::default(),
                }),
            )
            .await;
            client.close();
        });
    }

    /// Detach during the exit path, bounded hard: a wedged worker socket can
    /// never hold the client open (the exit contract is exit-within-1s even
    /// then, so this must stay well under the bound).
    pub(crate) async fn detach_for_exit(&self) {
        let _ = tokio::time::timeout(
            Duration::from_millis(EXIT_DETACH_TIMEOUT_MS),
            self.client.request_ok(DaemonCommand::Detach {
                id: None,
                active_session_id: Some(self.active_session_id.clone()),
                rest: Default::default(),
            }),
        )
        .await;
    }

    /// Fetch the exit resume hint (TS `shutdown` fetches `getSessionStats`
    /// while the connection is alive, then prints `formatResumeHint` after
    /// teardown). Bounded best-effort: a wedged worker or a dead connection
    /// yields no hint instead of holding the exit open.
    pub(crate) async fn exit_resume_hint(&self) -> Option<String> {
        let stats = tokio::time::timeout(
            Duration::from_millis(EXIT_STATS_TIMEOUT_MS),
            self.client.request_ok(DaemonCommand::GetSessionStats {
                id: None,
                active_session_id: self.active_session_id.clone(),
                rest: Default::default(),
            }),
        )
        .await;
        resume_hint_from_stats(&stats.ok()?.ok()?)
    }

    /// One daemon request with a hard await cap: the UI loop only ever
    /// blocks this long on it.
    async fn bounded_request(&self, timeout: Duration, command: DaemonCommand) -> Result<Value> {
        tokio::time::timeout(timeout, self.client.request_ok(command))
            .await
            .map_err(|_| {
                anyhow!(
                    "timed out after {}ms waiting for the Prime Agent daemon response",
                    timeout.as_millis()
                )
            })?
    }

    /// The retained-bytes budget for pasted images (TS
    /// `MAX_PASTED_IMAGE_BYTES`): the registry evicts oldest entries once
    /// the retained base64 payload exceeds it.
    const MAX_PASTED_IMAGE_BYTES: usize = 64 * 1024 * 1024;

    /// Read the clipboard image and register it behind a new editor
    /// marker (TS `handleClipboardImagePaste`). A clipboard without a
    /// supported image is a no-op; clipboard errors are silently ignored
    /// (the clipboard may lack permissions), matching the TS catch.
    async fn handle_clipboard_image_paste(&mut self, view: &mut AgentView) {
        let Some(attachment) = crate::clipboard_image::read_clipboard_image().await else {
            return;
        };
        let marker_id = self.next_image_marker_id;
        self.next_image_marker_id += 1;
        let mime_type = attachment.mime_type.clone();
        self.remember_pasted_image(marker_id, attachment, view);
        view.editor
            .insert_text_at_cursor(&format_image_marker(marker_id));
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.image_pasted(&mime_type).await;
            });
        }
        if !self.model_supports_images(view) {
            self.note(
                "Current model does not support images; the attachment will be omitted.",
                view,
            );
        }
        self.dirty = true;
    }

    /// Record a pasted image, evicting the oldest entries once the
    /// retained bytes exceed [`Self::MAX_PASTED_IMAGE_BYTES`] (TS
    /// `rememberPastedImage`). The just-added image and every image whose
    /// marker is still reachable are never evicted, so a live marker never
    /// loses its image.
    fn remember_pasted_image(&mut self, id: u64, image: LoadedImage, view: &AgentView) {
        self.pasted_images.insert(id, image);
        let mut keep = Self::live_image_marker_ids(&view.editor);
        keep.insert(id);
        let mut images = std::mem::take(&mut self.pasted_images);
        evict_images_to_budget(
            &mut images,
            |image: &LoadedImage| image.data.len(),
            Self::MAX_PASTED_IMAGE_BYTES,
            &keep,
        );
        self.pasted_images = images;
    }

    /// Marker ids still reachable - current editor text and prompt history
    /// (recallable with the up arrow) - which are never evicted so a
    /// recall never finds a marker with no image. The TS version also
    /// scans the compaction/connection queues, which live daemon-side
    /// here.
    fn live_image_marker_ids(editor: &crate::editor::Editor) -> std::collections::BTreeSet<u64> {
        let mut ids = std::collections::BTreeSet::new();
        ids.extend(image_marker_ids(&editor.get_text()));
        ids.extend(
            editor
                .get_history()
                .iter()
                .flat_map(|text| image_marker_ids(text)),
        );
        ids
    }

    // ---- Prompt stash (TS `prompt-stash-state.ts` + the interactive-mode
    // stash call sites). One client-owned store per TUI process holds every
    // session's stashed draft; the draft follows the session across
    // switches. ----

    /// TS `bindPromptStashSession`: the chat's stash state follows the
    /// connected session's stable id. The previous binding releases when
    /// it holds nothing, and the new binding's stashed images re-enter the
    /// paste registry with their marker ids reserved (TS
    /// `hydratePromptStash`), so a restore never mints colliding markers
    /// and a submitted restored draft finds its image bytes.
    fn bind_prompt_stash_session(&mut self, session_id: &str) {
        if self.stash_session_id == session_id {
            return;
        }
        let mut store = self
            .prompt_stash
            .lock()
            .expect("prompt stash store poisoned");
        if !self.stash_session_id.is_empty() {
            store.release(&self.stash_session_id);
        }
        let state = store.for_session(session_id);
        for stash in state.stash.iter().chain(state.queued_stashes.iter()) {
            for (id, image) in &stash.images {
                self.pasted_images.insert(*id, image.clone());
                self.next_image_marker_id = self.next_image_marker_id.max(id + 1);
            }
            for id in image_marker_ids(&stash.text) {
                self.next_image_marker_id = self.next_image_marker_id.max(id + 1);
            }
        }
        self.stash_session_id = session_id.to_string();
    }

    /// TS `teardownSessionUi` -> `releasePromptStashSession`: the run's
    /// binding ends. An empty state drops from the store; a session
    /// holding a draft keeps it for the next view that binds the session.
    pub(crate) fn release_prompt_stash_session(&mut self) {
        if self.stash_session_id.is_empty() {
            return;
        }
        let mut store = self
            .prompt_stash
            .lock()
            .expect("prompt stash store poisoned");
        store.release(&self.stash_session_id);
    }

    /// TS `snapshotPromptStash`: the editor draft plus the pasted images
    /// its markers still reference. `None` for a whitespace-only draft.
    /// Both capture paths (the agents-view handoff, the in-place switch)
    /// stash an auto-restore head (TS `restoreOnOpen`).
    fn snapshot_prompt_stash(&self, view: &AgentView) -> Option<PromptStash> {
        let text = view.editor.get_text();
        if text.trim().is_empty() {
            return None;
        }
        let images: Vec<(u64, LoadedImage)> = collect_marked_images(&self.pasted_images, &text)
            .into_iter()
            .map(|(id, image)| (id, image.clone()))
            .collect();
        // TS `snapshotPromptStashFrom`: a collapsed paste's content lives in
        // the editor's registry, not in the text, so the registry must
        // travel with the draft or the restored marker would stay literal
        // instead of expanding on submit.
        let snapshot = view.editor.get_paste_snapshot();
        let paste_snapshot = (!snapshot.pastes.is_empty()).then_some(snapshot);
        Some(PromptStash {
            text,
            paste_snapshot,
            images,
            restore_on_open: true,
        })
    }

    /// TS `stashDraftForAgentsView`: on the way to the agents view, the
    /// live draft becomes the session's restore-on-open head — an
    /// existing unrestored stash queues behind it and keeps its own
    /// restore semantics. The editor dies with this view, so the draft
    /// lives on only in the store.
    pub(crate) fn stash_draft_for_agents_view(&mut self, view: &AgentView) {
        let Some(draft) = self.snapshot_prompt_stash(view) else {
            return;
        };
        if let Some(telemetry) = self.telemetry.clone() {
            let had_images = !draft.images.is_empty();
            tokio::spawn(async move {
                telemetry.prompt_stash("agents_view", had_images).await;
            });
        }
        let mut store = self
            .prompt_stash
            .lock()
            .expect("prompt stash store poisoned");
        store
            .for_session(&self.stash_session_id)
            .stash_draft_head(draft);
    }

    /// The in-place `/switch` capture: the draft belongs to the session
    /// being left, so it is stashed as that session's restore head and the
    /// editor clears — the switched-to session starts from an empty prompt
    /// and the draft returns on a switch back.
    fn stash_draft_for_switch(&mut self, view: &mut AgentView) {
        let Some(draft) = self.snapshot_prompt_stash(view) else {
            return;
        };
        if let Some(telemetry) = self.telemetry.clone() {
            let had_images = !draft.images.is_empty();
            tokio::spawn(async move {
                telemetry.prompt_stash("session_switch", had_images).await;
            });
        }
        let mut store = self
            .prompt_stash
            .lock()
            .expect("prompt stash store poisoned");
        store
            .for_session(&self.stash_session_id)
            .stash_draft_head(draft);
        view.editor.set_text("");
        self.dirty = true;
    }

    /// TS `restorePromptStashOnOpen`: the opening restore of the session's
    /// auto-stashed draft. The restore notice lands in its own status
    /// block: init may have posted a notice (a tmux keyboard warning, a
    /// compaction row) that the back-to-back status rewrite would
    /// otherwise replace.
    pub(crate) fn restore_prompt_stash_on_open(&mut self, view: &mut AgentView) {
        self.last_status_index = None;
        self.restore_prompt_stash_if_editor_empty(view);
    }

    /// TS `restorePromptStashIfEditorEmpty`: the head draft returns to the
    /// editor only when the editor is empty; the next queued draft (if
    /// any) becomes the head. Returns whether a draft landed.
    fn restore_prompt_stash_if_editor_empty(&mut self, view: &mut AgentView) -> bool {
        if !view.editor.get_text().trim().is_empty() {
            return false;
        }
        let stash = {
            let mut store = self
                .prompt_stash
                .lock()
                .expect("prompt stash store poisoned");
            store
                .for_session(&self.stash_session_id)
                .take_head_restore_on_open()
        };
        let Some(stash) = stash else {
            return false;
        };
        for (id, image) in &stash.images {
            self.pasted_images.insert(*id, image.clone());
        }
        for id in image_marker_ids(&stash.text) {
            self.next_image_marker_id = self.next_image_marker_id.max(id + 1);
        }
        view.editor.set_text(&stash.text);
        // TS `restorePromptStash` -> `restorePasteSnapshot`: the collapsed
        // pastes re-enter the editor's registry so the restored markers
        // stay atomic and expand on submit.
        if let Some(snapshot) = &stash.paste_snapshot {
            view.editor.restore_paste_snapshot(snapshot.clone());
        }
        if let Some(telemetry) = self.telemetry.clone() {
            let had_images = !stash.images.is_empty();
            tokio::spawn(async move {
                telemetry.prompt_stash("restored", had_images).await;
            });
        }
        self.note("Restored stashed prompt", view);
        true
    }

    /// Whether the current model takes image input (TS
    /// `model.input.includes("image")`), when the model is known from the
    /// startup catalog; unknown models are assumed capable (the daemon
    /// re-checks against the resolved model anyway).
    fn model_supports_images(&self, view: &AgentView) -> bool {
        let Some(model_id) = view.chrome.model_id.as_deref() else {
            return true;
        };
        let Some(model) = self.model_catalog.iter().find(|model| model.id == model_id) else {
            return true;
        };
        model.input.contains(&pa_types::ai::ModelInput::Image)
    }

    /// Submit a prompt (the Enter path). The user message arrives back as a
    /// `message_start` session event (no local echo), and prompts sent while
    /// a turn is active queue on the daemon side.
    pub(crate) async fn submit_prompt(&mut self, text: &str, view: &mut AgentView) -> Result<()> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(());
        }
        // TS `!`/`!!` (interactive-mode onSubmit): the bash shortcut
        // routes before the side-question capture and every prompt path.
        // A bare `!`/`!!` is bash mode with nothing to run — it is never
        // sent as a prompt; a command runs directly through the
        // user-bash slot, no model turn involved.
        if let Some(bang) = crate::bash_bang::parse_bash_bang(text) {
            return match bang {
                crate::bash_bang::BashBang::Bare => Ok(()),
                crate::bash_bang::BashBang::Run(shortcut) => {
                    self.run_chat_bash(text, &shortcut, view).await
                }
            };
        }
        // An open side-question pane captures the submission (TS's ladder
        // order): builtin slash commands get the in-pane notice, a reply
        // with pasted images gets the image notice, and everything else
        // becomes a follow-up side question. A reply that merely starts
        // with "/" (an absolute path) is not a command.
        if view.side_pane.is_some() {
            let registry = SlashCommandRegistry::builtin();
            let is_command = pa_types::slash_commands::parse_slash_command(text)
                .is_some_and(|(name, _)| registry.is_builtin(&name));
            if is_command {
                self.add_side_notice(
                    text,
                    "Slash commands are not available in side conversations. Press esc to return to the main thread.",
                    view,
                );
                return Ok(());
            }
            if self.active_side_question_id.is_some() {
                // TS keeps the draft and shows the wait warning through
                // `handleSideQuestion`'s active-run guard.
                view.editor.set_text(text);
                self.start_side_question(text, view).await?;
                return Ok(());
            }
            if !collect_marked_images(&self.pasted_images, text).is_empty() {
                view.editor.set_text(text);
                self.add_side_notice(
                    text,
                    "Images are not supported in side conversations. Press esc to return to the main thread.",
                    view,
                );
                return Ok(());
            }
            view.editor.add_to_history(text);
            self.start_side_question(text, view).await?;
            return Ok(());
        }
        if text.starts_with('/') {
            return self.handle_slash(text, view).await;
        }
        // TS `clearShortcutGuide`: every prompt submission dismisses the
        // `?` quick-shortcut guide (slash commands keep it).
        view.shortcut_guide = None;
        self.send_prompt(text, SubmitBehavior::Steer, view).await
    }

    // ------------------------------------------------------------------
    // Side questions (/btw, /side)
    // ------------------------------------------------------------------

    /// One client-local notice turn (TS `sideQuestionComponent.addTurn`
    /// with a `side-notice-*` id): rendered like a turn, never sent to the
    /// daemon, never seeding a follow-up.
    fn add_side_notice(&mut self, question: &str, answer: &str, view: &mut AgentView) {
        self.side_question_counter += 1;
        let id = format!(
            "side-notice-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_millis())
                .unwrap_or_default(),
            self.side_question_counter
        );
        let turn = crate::side_question::SideQuestionTurn {
            id,
            question: question.to_string(),
            answer: answer.to_string(),
            status: "complete".to_string(),
            error_message: None,
            local: true,
        };
        view.side_pane
            .get_or_insert_with(crate::side_question::SideQuestionPane::default)
            .upsert(turn);
        self.dirty = true;
    }

    /// Start a side question (TS `handleSideQuestion`): the answered turns
    /// seed the follow-up's context, the pane mounts the running turn, and
    /// the daemon run streams `side_question_event` frames back.
    async fn start_side_question(&mut self, question: &str, view: &mut AgentView) -> Result<()> {
        if self.active_side_question_id.is_some() {
            self.note_as(
                "Wait for the current side question to finish or cancel it first.",
                StatusKind::Warning,
                view,
            );
            return Ok(());
        }
        let previous_turns: Vec<serde_json::Value> = view
            .side_pane
            .as_ref()
            .map(|pane| {
                pane.seed_turns()
                    .into_iter()
                    .map(|(question, answer)| {
                        serde_json::json!({ "question": question, "answer": answer })
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.side_question_counter += 1;
        let id = format!(
            "side-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| since.as_millis())
                .unwrap_or_default(),
            self.side_question_counter
        );
        let turn = crate::side_question::SideQuestionTurn {
            id: id.clone(),
            question: question.to_string(),
            answer: String::new(),
            status: "running".to_string(),
            error_message: None,
            local: false,
        };
        view.side_pane
            .get_or_insert_with(crate::side_question::SideQuestionPane::default)
            .upsert(turn);
        self.active_side_question_id = Some(id.clone());
        self.dirty = true;
        // TS sends `previousTurns` only when the pane already answered
        // something (`previousTurns.length > 0 ? previousTurns : undefined`).
        let previous_turns =
            (!previous_turns.is_empty()).then_some(serde_json::Value::Array(previous_turns));
        let started = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::StartSideQuestion {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    side_question_id: id.clone(),
                    question: question.to_string(),
                    previous_turns,
                    rest: Default::default(),
                },
            )
            .await;
        if let Err(error) = started {
            // TS surfaces the failed start as the turn's error state.
            self.active_side_question_id = None;
            if let Some(pane) = view.side_pane.as_mut() {
                pane.upsert(crate::side_question::SideQuestionTurn {
                    id,
                    question: question.to_string(),
                    answer: String::new(),
                    status: "error".to_string(),
                    error_message: Some(format!("{error:#}")),
                    local: false,
                });
            }
            self.dirty = true;
        }
        Ok(())
    }

    /// Close the side-question pane (TS `clearSideQuestion`): the active
    /// run aborts fire-and-forget (the daemon emits the cancelled event,
    /// which finds the pane already gone).
    async fn clear_side_question(&mut self, abort: bool, view: &mut AgentView) {
        // A side-conversation bash run dies with its pane: its `bash_*`
        // events may still be in flight (even bash_start), so they are
        // swallowed until its bash_end, and a run we observed starting
        // aborts (abort_bash is session-scoped, so only a run whose
        // bash_start we saw is aborted).
        if let Some(run) = self.side_bash.take() {
            let started = view
                .side_pane
                .as_ref()
                .is_some_and(|pane| pane.bash.is_some());
            self.side_bash_discarded = Some(run.run_id);
            if started {
                self.abort_user_bash();
            }
        }
        let active = self.active_side_question_id.take();
        if abort {
            if let Some(side_question_id) = active {
                let client = self.client.clone();
                let active_session_id = self.active_session_id.clone();
                tokio::spawn(async move {
                    let _ = client
                        .request_ok(DaemonCommand::AbortSideQuestion {
                            id: None,
                            active_session_id,
                            side_question_id,
                            rest: Default::default(),
                        })
                        .await;
                });
            }
        }
        view.side_pane = None;
        self.dirty = true;
    }

    /// One streamed `side_question_event` (TS `handleSideQuestionEvent`):
    /// upsert the turn into the pane; a terminal event for the active run
    /// releases the follow-up guard.
    fn apply_side_question_event(&mut self, event: &Value, view: &mut AgentView) {
        let Some(pane) = view.side_pane.as_mut() else {
            return;
        };
        let id = event.get("id").and_then(Value::as_str).unwrap_or_default();
        let status = event
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if self.active_side_question_id.as_deref() == Some(id) && status != "running" {
            self.active_side_question_id = None;
        }
        pane.upsert(crate::side_question::SideQuestionTurn {
            id: id.to_string(),
            question: event
                .get("question")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            answer: event
                .get("answer")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            status,
            error_message: event
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(str::to_string),
            local: false,
        });
        self.dirty = true;
    }

    /// Send a prompt to the session and start the working loader. Session
    /// commands travel the same path — the session engine parses and
    /// executes them instead of admitting a model turn. `behavior` is the
    /// TS streaming behavior: Enter parks mid-turn input on the steering
    /// lane, the follow-up key on the follow-up lane; an idle session runs
    /// either immediately. The images whose markers are present in
    /// `text`, or `None` when there are none (TS `collectImagesFor`).
    /// Resolved against the current model: when it has no image input the
    /// attachments are dropped here, matching the paste-time hint.
    fn collect_images_for(&self, text: &str, view: &AgentView) -> Option<serde_json::Value> {
        if !self.model_supports_images(view) {
            return None;
        }
        let images: Vec<&LoadedImage> = collect_marked_images(&self.pasted_images, text)
            .into_iter()
            .map(|(_, image)| image)
            .collect();
        if images.is_empty() {
            return None;
        }
        Some(serde_json::Value::Array(
            images
                .iter()
                .map(|image| {
                    serde_json::json!({
                        "type": "image",
                        "data": image.data,
                        "mimeType": image.mime_type,
                    })
                })
                .collect(),
        ))
    }

    /// TS `!command` / `!!command` (interactive-mode `onSubmit`): run the
    /// command through the daemon's user-bash slot — no model turn. `!`
    /// output enters the session context (the daemon records the durable
    /// `bashExecution` row, so follow-up prompts answer it); `!!` stays
    /// excluded. Inside a side conversation the run is transient: it
    /// renders in the pane, stays out of the main context, and (for `!`)
    /// seeds follow-up side questions.
    async fn run_chat_bash(
        &mut self,
        text: &str,
        shortcut: &crate::bash_bang::BashShortcut,
        view: &mut AgentView,
    ) -> Result<()> {
        // Every prompt submission dismisses the `?` shortcut guide (TS
        // `clearShortcutGuide` at onSubmit's top).
        view.shortcut_guide = None;
        // A running user command blocks a second one (TS `isBashRunning`
        // guard); the editor buffer already cleared on submit, so the
        // draft is not restored.
        if self.user_bash_running {
            self.note_as(
                &already_running_warning(&self.keybindings),
                StatusKind::Warning,
                view,
            );
            return Ok(());
        }
        // A streaming side turn blocks bash like it blocks follow-up
        // replies: overlapping pane turns would seed out of order; the
        // draft returns to the editor (TS `editor.setText(text)`).
        if view.side_pane.is_some() && self.active_side_question_id.is_some() {
            view.editor.set_text(text);
            self.note_as(
                "\u{26a0} Wait for the current side question to finish or cancel it first.",
                StatusKind::Warning,
                view,
            );
            return Ok(());
        }
        // Inside a side conversation the command runs inside the pane
        // (its bash_start mounts the row there), stays out of the
        // main-session context, and (for `!`, not `!!`) seeds follow-up
        // side questions.
        let side_bash = view.side_pane.is_some().then(|| {
            self.side_bash_counter += 1;
            SideBashRun {
                run_id: format!("side-bash-{}", self.side_bash_counter),
                input: text.to_string(),
                seed_transcript: !shortcut.excluded,
            }
        });
        if side_bash.is_none() {
            // Main-thread bash clears any side-question state first (TS
            // `clearSideQuestion({ abort: true })`).
            self.clear_side_question(true, view).await;
        }
        view.editor.add_to_history(text);
        // Optimistic running flag (TS `patchConnectionState({
        // isBashRunning: true })`): bash_start only fires after the
        // dispatch, and the clear key must already route to abort_bash
        // in that window.
        self.user_bash_running = true;
        if let Some(telemetry) = self.telemetry.clone() {
            let excluded = shortcut.excluded;
            let side_conversation = side_bash.is_some();
            tokio::spawn(async move {
                telemetry
                    .bash_shortcut_used(excluded, side_conversation)
                    .await;
            });
        }
        let run_id = side_bash.as_ref().map(|run| run.run_id.clone());
        let excluded = shortcut.excluded || side_bash.is_some();
        if let Some(run) = side_bash {
            self.side_bash = Some(run);
        }
        let request = DaemonCommand::ExecuteBash {
            id: None,
            active_session_id: self.active_session_id.clone(),
            command: shortcut.command.clone(),
            exclude_from_context: Some(excluded),
            transient: run_id.is_some().then_some(true),
            run_id: run_id.clone(),
            rest: Default::default(),
        };
        if let Err(error) = self
            .bounded_request(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), request)
            .await
        {
            // The rejection may mean another client's bash run already
            // holds the slot (TS re-syncs from the daemon state; the
            // settled events patch it either way) — assume idle.
            self.user_bash_running = false;
            if run_id.is_some() && self.side_bash.as_ref().map(|run| run.run_id.clone()) == run_id {
                self.side_bash = None;
            }
            if run_id.is_some() && self.side_bash_discarded == run_id {
                // The pane discarded this run, but it never started, so
                // no bash_end will arrive to consume the marker.
                self.side_bash_discarded = None;
            }
            self.error_row(&format!("{error:#}"), view);
        }
        self.dirty = true;
        Ok(())
    }

    async fn send_prompt(
        &mut self,
        text: &str,
        behavior: SubmitBehavior,
        view: &mut AgentView,
    ) -> Result<()> {
        if let Some(error) = self.reconnection_failed.clone() {
            // The re-attach window expired (TS terminal close): the session
            // connection is closed, so nothing dispatches. The error row
            // surfaces the terminal cause and the draft returns to the
            // editor (TS keeps the input buffer on a failed submit).
            self.error_row(&format!("Daemon reconnection failed: {error}"), view);
            view.editor.set_text(text);
            return Ok(());
        }
        let images = self.collect_images_for(text, view);
        self.bounded_request(
            Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
            DaemonCommand::Prompt {
                id: None,
                active_session_id: self.active_session_id.clone(),
                message: text.to_string(),
                input: pa_types::daemon::PromptInput {
                    content: None,
                    images,
                    streaming_behavior: Some(match behavior {
                        SubmitBehavior::Steer => pa_types::daemon::StreamingBehavior::Steer,
                        SubmitBehavior::FollowUp => pa_types::daemon::StreamingBehavior::FollowUp,
                    }),
                    queue_if_busy: Some(true),
                    expand_prompt_templates: None,
                    source: None,
                    agent_message_id: None,
                    custom_message: None,
                    queue_key: None,
                    prefix_messages: None,
                    admission_id: None,
                },
                rest: Default::default(),
            },
        )
        .await
        .map_err(|error| anyhow!("{error:#}"))?;
        // A submission while a turn runs parks in the queue behind it: the
        // queue strip shows the message until the session delivers it
        // (adoption telemetry for the follow-up queue).
        if self.turn_active {
            if let Some(telemetry) = self.telemetry.clone() {
                let lane = match behavior {
                    SubmitBehavior::Steer => "steering",
                    SubmitBehavior::FollowUp => "follow_up",
                };
                tokio::spawn(async move {
                    telemetry.queued_input(lane).await;
                });
            }
        }
        if !self.turn_active {
            self.turn_active = true;
        }
        self.start_loader(view);
        self.dirty = true;
        Ok(())
    }

    /// The working loader starts with a `Waiting` activity and a zero
    /// token count (TS `agent_start` resets the tracker).
    fn start_loader(&mut self, view: &mut AgentView) {
        view.working = Some(WorkingState {
            activity: "Waiting",
            message: None,
            download: false,
            tokens: 0,
            elapsed_secs: 0,
        });
        view.working_since = Some(std::time::Instant::now());
        self.working_tokens.reset();
    }

    /// Update the loader's activity label from one provider stream event
    /// (TS `AgentActivityTracker`: thinking/text/toolcall events switch the
    /// label and direction). Token counting lives in
    /// [`Self::track_stream_tokens`]: the event's own delta is only the
    /// last of possibly many coalesced provider deltas, so the message —
    /// not the delta — carries the token truth.
    fn track_stream_activity(&mut self, event: &Value, view: &mut AgentView) {
        let (activity, download) = match event.get("type").and_then(Value::as_str) {
            Some("thinking_start") | Some("thinking_delta") => ("Thinking", true),
            Some("text_start") | Some("text_delta") => ("Writing", true),
            Some("toolcall_start") | Some("toolcall_delta") => ("Writing code", true),
            _ => return,
        };
        if let Some(working) = &mut view.working {
            working.activity = activity;
            working.download = download;
        }
    }
}

/// The loader's token accounting (TS `AgentActivityTracker`): the live
/// count is completed-message output tokens plus max(reported usage, the
/// content estimate at 4 chars per token), reported monotonically within a
/// run. The live count derives from the streamed message itself — never
/// from per-delta sums — because the worker coalesces provider deltas into
/// latest-snapshot frames and a delta sum would undercount.
#[derive(Debug, Default)]
struct LoaderTokenTracker {
    /// Settled-message output tokens, banked at `message_end` (TS
    /// `completedTokens`).
    completed_tokens: u64,
    /// The streaming message's reported `usage.output` (TS
    /// `streamingUsageTokens`).
    streaming_usage: u64,
    /// The streaming message's content size in chars (TS accumulates the
    /// same value as a delta sum; the snapshot message carries it directly).
    streaming_chars: u64,
}

impl LoaderTokenTracker {
    /// TS `agent_start`/`reset`: a fresh run counts from zero.
    fn reset(&mut self) {
        self.completed_tokens = 0;
        self.start_message();
    }

    /// TS `message_start` (assistant): the new message's live state starts
    /// empty — its reported usage only counts from the first update.
    fn start_message(&mut self) {
        self.streaming_usage = 0;
        self.streaming_chars = 0;
    }

    /// TS `message_update`: adopt the message's reported usage and size,
    /// returning the live count.
    fn apply_streaming(&mut self, usage_output: u64, content_chars: u64) -> u64 {
        self.streaming_usage = usage_output;
        self.streaming_chars = content_chars;
        self.current()
    }

    /// TS `message_end`: bank the message's tokens into the completed
    /// count (authoritative usage when reported, else the live estimate)
    /// and clear the live state.
    fn settle(&mut self, usage_output: u64) {
        let estimate = (self.streaming_chars as f64 / 4.0).round() as u64;
        self.completed_tokens += if usage_output > 0 {
            usage_output
        } else {
            estimate
        };
        self.start_message();
    }

    /// TS `currentTokens`: completed tokens plus max(reported usage, the
    /// chars/4 estimate).
    fn current(&self) -> u64 {
        let estimate = (self.streaming_chars as f64 / 4.0).round() as u64;
        self.completed_tokens + self.streaming_usage.max(estimate)
    }
}

impl SessionUi {
    /// Slash-command dispatch (the TS interactive submission ladder reduced
    /// to this client's surface): local client commands run here, builtin
    /// client commands without a UI yet report unavailability, session
    /// commands (`compact`/`refine`/`goal`/`autonomous`) forward to the
    /// session, and unknown commands get the TS suggestion error — anything
    /// without a suggestion passes through as a prompt.
    async fn handle_slash(&mut self, text: &str, view: &mut AgentView) -> Result<()> {
        let registry = SlashCommandRegistry::builtin();
        let (name, args) = pa_types::slash_commands::parse_slash_command(text)
            .unwrap_or_else(|| (String::new(), String::new()));

        // Client-local commands this build implements (not TS builtins).
        match name.as_str() {
            "help" => {
                self.note(
                    "/help           this list\n/list           live sessions\n/switch <n|id>  switch to a session from /list\n/new            start a new session\n/exit           detach and exit",
                    view,
                );
                return Ok(());
            }
            "list" => {
                self.refresh_list(view).await?;
                return Ok(());
            }
            "switch" => {
                if args.is_empty() {
                    self.note("usage: /switch <n|id> (run /list first)", view);
                } else {
                    self.switch_to(&args, view).await?;
                }
                return Ok(());
            }
            "exit" => {
                self.exit_requested = true;
                return Ok(());
            }
            _ => {}
        }

        let Some(resolved) = registry.parse(text) else {
            // Oversized names are prompts (TS `_throwIfUnknownSlashCommand`
            // bails out before fuzzy matching). Close typos get the exact TS
            // error; everything else passes through to the model.
            if name.chars().count() > 64 {
                return self.send_prompt(text, SubmitBehavior::Steer, view).await;
            }
            let candidates = registry.suggestion_candidates();
            return match pa_types::slash_commands::find_slash_command_suggestion(&name, &candidates)
            {
                Some(suggestion) => {
                    self.note(
                        &format!("Unknown command: /{name}. Did you mean /{suggestion}?"),
                        view,
                    );
                    Ok(())
                }
                None => self.send_prompt(text, SubmitBehavior::Steer, view).await,
            };
        };

        let command = registry
            .get(resolved.name)
            .expect("resolved name is builtin");
        match command.execution {
            SlashCommandExecution::Session => {
                self.send_prompt(text, SubmitBehavior::Steer, view).await
            }
            SlashCommandExecution::Client => {
                self.dispatch_client_command(&resolved, text, view).await
            }
        }
    }

    /// A builtin client command. Only the implemented subset runs locally;
    /// commands whose UI does not exist yet report unavailability. `text` is
    /// the typed submission (the client echo rows render it verbatim).
    async fn dispatch_client_command(
        &mut self,
        resolved: &pa_types::slash_commands::ResolvedSlashCommand,
        text: &str,
        view: &mut AgentView,
    ) -> Result<()> {
        match resolved.name {
            // `/clear` stays the no-argument compatibility alias of `/new`
            // (TS refuses arguments to it).
            "new" if resolved.original_name == "clear" && !resolved.args.is_empty() => {
                self.note("Usage: /clear", view);
            }
            "new" => {
                let id = create_session(&self.client, &self.create_options(), None).await?;
                self.attach_session(&id).await?;
                self.rebuild_view(view);
                self.note(&format!("started session {id}"), view);
            }
            // TS `/quit` shuts the client down; this build's exit detaches
            // and exits (the session keeps running in the daemon).
            "quit" => {
                self.exit_requested = true;
            }
            // `/resume` (TS: open the agents view, or resume a session by
            // id or path). Both paths detach this session first; the CLI
            // loop then opens the agents view or the resolved selection.
            "resume" => {
                if resolved.args.is_empty() {
                    self.open_agents_view = true;
                    self.exit_requested = true;
                } else {
                    match self.resolve_resume_selector(&resolved.args) {
                        Some(selection) => {
                            self.pending_selection = Some(selection);
                            self.exit_requested = true;
                        }
                        None => {
                            self.note(
                                &format!("could not resolve session \"{}\"", resolved.args),
                                view,
                            );
                        }
                    }
                }
            }
            // `/model [search]` (TS `handleModelCommand` →
            // `showConfigurationMenu("models")`): open the inline menu
            // panel over the cached catalog, the search term prefilled as
            // its filter; a refresh fires in the background when the
            // snapshot is stale (forced when a search argument rides the
            // command) and lands into the open picker.
            "model" => {
                self.track_command_used("model");
                let current = self.current_model(view);
                let thinking_level = self
                    .picker_initial_thinking_level(current.as_ref(), view)
                    .await;
                let options = ModelPickerOptions {
                    models: self.model_catalog.clone(),
                    current,
                    configured_providers: self.model_configured_providers.clone(),
                    recent_models: self.model_recent_models.clone(),
                    thinking_level,
                    viewport_rows: picker_viewport_rows(view.terminal_rows()),
                };
                // TS `handleModelCommand` always opens the menu (an empty
                // catalog renders the empty panel).
                let crate::model_picker::ModelCommandOutcome::Open(picker) =
                    ModelPicker::open(options, &resolved.args);
                view.model_picker = Some(*picker);
                // TS `refreshModels(initialModelSearch !== undefined)`.
                let force = !resolved.args.trim().is_empty();
                if self.model_refresh_due(force) {
                    self.spawn_model_catalog_refresh();
                }
            }
            // `/effort [level]` (TS `handleEffortCommand`): the
            // session's thinking levels drive the outcome — a model
            // without reasoning reports the TS note, a missing argument
            // opens the picker, and a valid argument applies directly.
            "effort" => {
                self.track_command_used("effort");
                let Some(state) = self.connection_state(view).await else {
                    return Ok(());
                };
                let levels: Vec<String> = state
                    .get("availableThinkingLevels")
                    .and_then(Value::as_array)
                    .map(|levels| {
                        levels
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                // TS `getAvailableThinkingLevels`: an "off"-only list is
                // no thinking surface.
                let levels: Vec<String> = if levels.len() == 1 && levels[0] == "off" {
                    Vec::new()
                } else {
                    levels
                };
                let current = state
                    .get("thinkingLevel")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                match effort_picker::effort_command(&levels, current.as_deref(), &resolved.args) {
                    effort_picker::EffortCommandOutcome::Open(picker) => {
                        view.effort_picker = Some(picker);
                    }
                    effort_picker::EffortCommandOutcome::Unsupported => {
                        self.note("Current model does not support thinking", view);
                    }
                    effort_picker::EffortCommandOutcome::Unknown { requested, levels } => {
                        // TS `showError`: the ⚠ Error row, not the muted note.
                        view.push_entry(ChatEntry::Status {
                            text: format!(
                                "\u{26a0} Error: Unknown thinking level '{requested}'. Available: {}",
                                levels.join(", ")
                            ),
                            kind: StatusKind::Error,
                        });
                        self.dirty = true;
                    }
                    effort_picker::EffortCommandOutcome::Apply { level } => {
                        self.apply_thinking_level(&level, view).await;
                    }
                }
            }
            // `/tree` (TS `showTreeSelector`): the session-tree navigator.
            "tree" => {
                if !resolved.args.is_empty() {
                    self.note("Usage: /tree", view);
                } else {
                    self.track_command_used("tree");
                    self.open_tree_selector(view, None).await?;
                }
            }
            // `/fork` (TS `showUserMessageSelector`): fork from a user
            // message into a new session.
            "fork" => {
                if !resolved.args.is_empty() {
                    self.note("Usage: /fork", view);
                } else {
                    self.track_command_used("fork");
                    self.open_fork_selector(view).await?;
                }
            }
            // `/clone` (TS `handleCloneCommand`): duplicate the session at
            // the current position.
            "clone" => {
                if !resolved.args.is_empty() {
                    self.note("Usage: /clone", view);
                } else {
                    self.track_command_used("clone");
                    self.handle_clone_command(view).await?;
                }
            }
            // TS `handleCopyCommand`: the last assistant text (the
            // daemon `get_last_assistant_text` lookup) copied to the
            // clipboard (platform tools, OSC 52 fallback). An argument is
            // the usage error with the text kept in the editor.
            "copy" => {
                if !resolved.args.is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /copy", view);
                } else {
                    self.track_command_used("copy");
                    self.handle_copy_command(view).await?;
                }
            }
            // `/login` (TS `showConfigurationMenu("providers")`): the
            // providers selector this build ports of that tab (the full
            // configuration menu stays unported; the panel is the same
            // TS `OAuthSelectorComponent` the tab mounts).
            "login" => {
                if !resolved.args.is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /login", view);
                } else {
                    self.track_command_used("login");
                    self.open_provider_auth(AuthSelectorKind::Login, view)
                        .await?;
                }
            }
            // `/logout` (TS `showLogoutSelector`): the stored-credential
            // selector; an empty store answers the TS status directly.
            "logout" => {
                if !resolved.args.is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /logout", view);
                } else {
                    self.track_command_used("logout");
                    self.open_provider_auth(AuthSelectorKind::Logout, view)
                        .await?;
                }
            }
            // `/import <path.jsonl>` (TS `handleImportCommand`): the
            // path parses like `/export`'s, then the confirm guards the
            // replacement.
            "import" => {
                self.track_command_used("import");
                let command_text = if resolved.args.is_empty() {
                    "/import".to_string()
                } else {
                    format!("/import {}", resolved.args)
                };
                self.open_import_confirm(&command_text, view);
            }
            // `/traces [status|on|off|preview|upload|upload-current|
            // upload-all|login]` (TS `handleTracesCommand`): the status
            // block, the settings writes, and the TS command shapes over
            // the upload subsystem this build has.
            "traces" => {
                self.track_command_used("traces");
                self.handle_traces_command(resolved, view).await?;
            }
            // `/update [source|--self|--extensions|--extension <source>
            // |--force|--rollback|--nightly|--stable]` (TS
            // `handleUpdateCommand`): the busy guard, then the child
            // runs own the terminal (a successful self-update replaces
            // this process with the updated CLI).
            "update" => {
                self.track_command_used("update");
                let plan = crate::update_command::parse_update_args(
                    &resolved
                        .args
                        .split_whitespace()
                        .map(str::to_string)
                        .collect::<Vec<String>>(),
                );
                // TS: the guard applies when the run does not update the
                // binary (package updates wait for the turn; the self path
                // tears the session down anyway).
                if !plan.includes_self && self.turn_active {
                    self.note_as(
                        "Wait for the current work to finish before updating.",
                        StatusKind::Warning,
                        view,
                    );
                } else {
                    view.editor.set_text("");
                    self.pending_update = Some(plan);
                }
            }
            // TS `handleMcpCommand`'s login/logout branches: the auth
            // flows run in the client process (the composition root's
            // hook); the other management subcommands surface through the
            // `mcp` CLI command instead of the TUI.
            "mcp" => self.handle_mcp_command(resolved, view).await?,
            // TS `handleExportCommand`: an explicit `.jsonl` path exports
            // the current branch; anything else (including no argument)
            // exports HTML.
            "export" => {
                self.track_command_used("export");
                self.handle_export_command(resolved, view).await?;
            }
            // TS `handleShareCommand`: an argument is the usage error (the
            // text stays in the editor); otherwise the session exports to a
            // temp file and uploads as a secret gist.
            "share" => {
                if !resolved.args.is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /share", view);
                } else {
                    self.track_command_used("share");
                    self.handle_share_command(view).await?;
                }
            }
            // `/hotkeys` (TS `handleHotkeysCommand` after
            // `echoLocalCommand`): the typed command echoes as a user
            // message block, then the full keyboard-shortcut reference
            // renders from the EFFECTIVE bindings so user
            // `keybindings.json` overrides show their keys. Client-side
            // rows only, never durable session entries.
            "hotkeys" => {
                self.track_command_used("hotkeys");
                if !resolved.args.is_empty() {
                    // TS keeps the text in the editor on the usage error.
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /hotkeys", view);
                    return Ok(());
                }
                view.push_entry(ChatEntry::User {
                    text: "/hotkeys".to_string(),
                });
                view.push_entry(ChatEntry::ClientMarkdown {
                    text: crate::hotkeys::hotkeys_guide(view.editor.keybindings()),
                });
                self.dirty = true;
            }

            // `/session` (TS `handleSessionCommand`): the daemon's session
            // stats as the `Session Info` block after the command echo.
            "session" => {
                self.track_command_used("session");
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /session", view);
                    return Ok(());
                }
                view.push_entry(ChatEntry::User {
                    text: text.to_string(),
                });
                let stats = self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::GetSessionStats {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            rest: Default::default(),
                        },
                    )
                    .await;
                match stats {
                    Ok(stats) => {
                        let name = self.session_name.clone();
                        view.push_entry(ChatEntry::ClientText {
                            rows: info_commands::session_info_rows(&stats, name.as_deref()),
                        });
                        self.dirty = true;
                    }
                    Err(error) => {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            // `/context` and its `/usage` alias (TS
            // `handleContextCommand` over `formatContextTree`): the agent
            // tree with own token/cost columns and context utilization.
            "context" => {
                self.track_command_used("context");
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /context", view);
                    return Ok(());
                }
                view.push_entry(ChatEntry::User {
                    text: text.to_string(),
                });
                let tree = self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::GetContextTree {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            rest: Default::default(),
                        },
                    )
                    .await;
                match tree {
                    Ok(tree) => {
                        // TS render width: clamp(columns - 2, 60, 120).
                        let width = terminal_columns().saturating_sub(2).clamp(60, 120);
                        view.push_entry(ChatEntry::ClientText {
                            rows: info_commands::context_tree_rows(&tree, width),
                        });
                        self.dirty = true;
                    }
                    Err(error) => {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            // `/system-prompt` (TS `handleSystemPromptCommand`): the header
            // with the char count, then the exact assembled prompt.
            "system-prompt" => {
                self.track_command_used("system-prompt");
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /system-prompt", view);
                    return Ok(());
                }
                view.push_entry(ChatEntry::User {
                    text: text.to_string(),
                });
                let prompt = self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::GetSystemPrompt {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            rest: Default::default(),
                        },
                    )
                    .await;
                match prompt {
                    Ok(data) => {
                        let prompt = data
                            .get("systemPrompt")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        view.push_entry(ChatEntry::ClientText {
                            rows: info_commands::system_prompt_header_rows(prompt),
                        });
                        view.push_entry(ChatEntry::ClientText {
                            rows: info_commands::system_prompt_body_rows(prompt),
                        });
                        self.dirty = true;
                    }
                    Err(error) => {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            // `/logs` (TS `handleLogsCommand`): a client-side read of the
            // logs directory (the daemon writes it, this client lists it).
            "logs" => {
                self.track_command_used("logs");
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /logs", view);
                    return Ok(());
                }
                view.push_entry(ChatEntry::User {
                    text: text.to_string(),
                });
                let Some(agent_dir) = pa_types::platform::agent_dir() else {
                    self.error_row(
                        "home directory not found: set HOME (or USERPROFILE on Windows)",
                        view,
                    );
                    return Ok(());
                };
                view.push_entry(ChatEntry::ClientText {
                    rows: info_commands::logs_rows(&agent_dir.join("logs")),
                });
                self.dirty = true;
            }
            // `/changelog` (TS `handleChangelogCommand`): the shipped
            // CHANGELOG.md entries, newest first, between the panel
            // borders.
            "changelog" => {
                self.track_command_used("changelog");
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /changelog", view);
                    return Ok(());
                }
                view.push_entry(ChatEntry::User {
                    text: text.to_string(),
                });
                view.push_entry(ChatEntry::ChangelogPanel {
                    markdown: info_commands::changelog_markdown(&Self::changelog_path()),
                });
                self.dirty = true;
            }
            // `/settings` (TS `showSettingsSelector`): the inline settings
            // menu; the rows read the daemon state and the settings seam.
            "settings" => {
                if !resolved.args.is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /settings", view);
                    return Ok(());
                }
                self.track_command_used("settings");
                self.open_settings_menu(view).await;
            }
            // `/btw` (TS `handleSideQuestion` via the submit ladder; `/side`
            // resolves to it): start a side question without touching the
            // session transcript; the pane stays open for follow-ups until
            // esc returns to the main thread.
            "btw" => {
                if resolved.args.is_empty() {
                    self.note_as("Usage: /btw <question>", StatusKind::Warning, view);
                    return Ok(());
                }
                self.track_command_used("btw");
                self.start_side_question(&resolved.args, view).await?;
            }
            // `/name` (TS `handleNameCommand`; `/rename` resolves to it):
            // a missing argument reports the current name, otherwise the
            // rename travels to the daemon (`set_session_name` persists
            // the `session_info` entry and broadcasts the change).
            "name" => {
                self.track_command_used("name");
                let name = resolved.args.trim();
                if name.is_empty() {
                    match &self.session_name {
                        Some(current) => self.note(&format!("Session name: {current}"), view),
                        None => self.note_as("Usage: /name <name>", StatusKind::Warning, view),
                    }
                    return Ok(());
                }
                match self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::SetSessionName {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            name: name.to_string(),
                            worker_token: None,
                            rest: Default::default(),
                        },
                    )
                    .await
                {
                    Ok(_) => {
                        self.session_name = Some(name.to_string());
                        view.chrome.chat_name = self.session_display();
                        self.plain_row(&format!("Session name set: {name}"), view);
                    }
                    Err(error) => self.error_row(&format!("{error:#}"), view),
                }
            }
            // `/fast` (TS `handleFastCommand`): toggle the priority service
            // tier on a fast-mode-eligible model; the state refresh after
            // the switch drives the status row.
            "fast" => {
                self.track_command_used("fast");
                if !resolved.args.is_empty() {
                    self.error_row("Usage: /fast", view);
                    return Ok(());
                }
                self.handle_fast_command(view).await;
            }
            // `/rlm-max-depth` (TS `handleRlmMaxDepthCommand`): view or set
            // the per-chat recursive depth limit.
            "rlm-max-depth" => {
                self.track_command_used("rlm-max-depth");
                self.handle_rlm_max_depth_command(view, &resolved.args)
                    .await;
            }
            // `/fullscreen [on|off]` (TS `setFullscreenMode`): persist the
            // preference and report the TS status row. This surface always
            // renders on the alternate screen (the Rust TUI has no inline
            // rendering mode yet), so the toggle changes the persisted
            // preference and the reported state, not the surface.
            "fullscreen" => {
                self.track_command_used("fullscreen");
                let arg = resolved.args.trim().to_lowercase();
                if !arg.is_empty() && arg != "on" && arg != "off" {
                    self.error_row("Usage: /fullscreen [on|off]", view);
                    return Ok(());
                }
                let enable = match arg.as_str() {
                    "on" => true,
                    "off" => false,
                    _ => !self.fullscreen_enabled,
                };
                self.set_fullscreen_mode(enable, view);
            }
            // `/reload` (TS `handleReloadCommand`): the guards first (a
            // streaming turn or compaction defers the reload), then the
            // bordered loader replaces the editor while the daemon and the
            // client re-read their inputs.
            "reload" => {
                if !resolved.args.is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /reload", view);
                    return Ok(());
                }
                self.track_command_used("reload");
                if self.turn_active || view.working.is_some() {
                    self.note_as(
                        "Wait for the current response to finish before reloading.",
                        StatusKind::Warning,
                        view,
                    );
                    return Ok(());
                }
                if view.compaction.is_some() {
                    self.note_as(
                        "Wait for compaction to finish before reloading.",
                        StatusKind::Warning,
                        view,
                    );
                    return Ok(());
                }
                self.handle_reload_command(view).await?;
            }
            // `/heartbeats` (TS `showHeartbeatManager`): the inline
            // management view over the session-scoped heartbeat catalog —
            // this session's and its RLM children's user and agent
            // heartbeats. An argument is the TS usage error (the text
            // stays in the editor).
            "heartbeats" => {
                if !resolved.args.is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /heartbeats", view);
                    return Ok(());
                }
                self.track_command_used("heartbeats");
                self.open_heartbeats_view(view).await;
            }
            other => {
                self.note(
                    &format!("/{other} is not available in this client yet"),
                    view,
                );
            }
        }
        Ok(())
    }

    /// The shipped CHANGELOG.md path (TS `getChangelogPath`): the package
    /// directory (`PI_PACKAGE_DIR` wins, else the directory of the running
    /// executable — the TS bun-binary layout) plus `CHANGELOG.md`.
    fn changelog_path() -> std::path::PathBuf {
        let package_dir = match std::env::var("PI_PACKAGE_DIR") {
            Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|parent| parent.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from(".")),
        };
        package_dir.join("CHANGELOG.md")
    }

    // ------------------------------------------------------------------
    // Session import (/import)
    // ------------------------------------------------------------------

    /// The import confirm (TS `handleImportCommand`'s
    /// `showExtensionConfirm`): parse the path, park the confirm, and let
    /// the panel answer it.
    fn open_import_confirm(&mut self, command_text: &str, view: &mut AgentView) {
        let Some(input_path) = crate::export_share::path_command_argument(command_text, "/import")
        else {
            self.error_row("Usage: /import <path.jsonl>", view);
            return;
        };
        view.editor.set_text("");
        view.confirm = Some(crate::confirm::ConfirmPanel::yes_no(
            "Import session",
            &format!("Replace current session with {input_path}?"),
        ));
        self.pending_confirm = Some(PendingConfirm::Import { path: input_path });
        self.dirty = true;
    }

    /// One key press while the confirm panel owns the frame.
    async fn handle_confirm_key(&mut self, key: KeyEvent, view: &mut AgentView) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        let action = {
            let Some(confirm) = view.confirm.as_mut() else {
                return Ok(());
            };
            let kb = view.editor.keybindings();
            confirm.handle_key(kb, &id)
        };
        match action {
            crate::confirm::ConfirmAction::None => {}
            crate::confirm::ConfirmAction::Cancel => {
                view.confirm = None;
                self.pending_confirm = None;
            }
            crate::confirm::ConfirmAction::Select(option) => {
                let pending = self.pending_confirm.take();
                view.confirm = None;
                if option == "Yes" {
                    match pending {
                        Some(PendingConfirm::Import { path }) => {
                            self.run_import(&path, None, view).await?;
                        }
                        Some(PendingConfirm::ImportCwdFallback { path, fallback_cwd }) => {
                            self.run_import(&path, Some(&fallback_cwd), view).await?;
                        }
                        None => {}
                    }
                }
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// The import request and its outcomes (TS `handleImportCommand`'s
    /// `importFromJsonl` call: the cancelled note, the typed error
    /// surfaces, and the successful rebuild + status).
    async fn run_import(
        &mut self,
        input_path: &str,
        cwd_override: Option<&str>,
        view: &mut AgentView,
    ) -> Result<()> {
        let response = self
            .client
            .request(DaemonCommand::ImportJsonl {
                id: None,
                active_session_id: self.active_session_id.clone(),
                input_path: input_path.to_string(),
                cwd_override: cwd_override.map(str::to_string),
                rest: Default::default(),
            })
            .await?;
        if !response.success {
            let error = response.error.unwrap_or_default();
            match response.error_info {
                Some(pa_types::daemon::DaemonErrorInfo::SessionImportFileNotFound {
                    file_path,
                }) => {
                    self.error_row(
                        &format!("Failed to import session: File not found: {file_path}"),
                        view,
                    );
                }
                Some(pa_types::daemon::DaemonErrorInfo::MissingSessionCwd { issue }) => {
                    // TS `promptForMissingSessionCwd`: the confirm carries
                    // the issue's text, and `Yes` retries with the fallback
                    // cwd as the override.
                    let session_cwd = issue
                        .get("sessionCwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let fallback_cwd = issue
                        .get("fallbackCwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    view.confirm = Some(crate::confirm::ConfirmPanel::yes_no(
                        "Session cwd not found",
                        &format!(
                            "cwd from session file does not exist\n{session_cwd}\n\ncontinue in current cwd\n{fallback_cwd}"
                        ),
                    ));
                    self.pending_confirm = Some(PendingConfirm::ImportCwdFallback {
                        path: input_path.to_string(),
                        fallback_cwd,
                    });
                    self.dirty = true;
                }
                _ => {
                    self.error_row(&format!("Failed to import session: {error}"), view);
                }
            }
            return Ok(());
        }
        if response
            .data
            .as_ref()
            .and_then(|data| data.get("cancelled"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            self.note("Import cancelled", view);
            return Ok(());
        }
        // TS `renderCurrentSessionState`: the replacement's fresh branch
        // renders from scratch, then the status row lands.
        self.rebuild_transcript(view).await;
        self.refresh_stats().await;
        self.note(&format!("Session imported from: {input_path}"), view);
        Ok(())
    }

    // ------------------------------------------------------------------
    // Provider auth (/login, /logout)
    // ------------------------------------------------------------------

    /// `/login` / `/logout` (TS `showConfigurationMenu("providers")` /
    /// `showLogoutSelector`): fetch the hook's rows and mount the selector.
    /// An empty logout store answers the TS status directly.
    async fn open_provider_auth(
        &mut self,
        kind: AuthSelectorKind,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(auth) = self.provider_auth.clone() else {
            let command = if kind == AuthSelectorKind::Login {
                "/login"
            } else {
                "/logout"
            };
            self.note(
                &format!("{command} is not available in this client yet"),
                view,
            );
            return Ok(());
        };
        let rows = match kind {
            AuthSelectorKind::Login => auth.0.login_options().await,
            AuthSelectorKind::Logout => auth.0.logout_options().await,
        };
        if kind == AuthSelectorKind::Logout && rows.is_empty() {
            self.note(
                "No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
                view,
            );
            return Ok(());
        }
        view.editor.set_text("");
        view.provider_auth = Some(crate::provider_auth::ProviderAuthSelector::new(kind, rows));
        self.dirty = true;
        Ok(())
    }

    /// One key press while the provider selector owns the frame (TS
    /// `OAuthSelectorComponent.handleInput`): Enter closes the panel and
    /// runs the row's flow; the terminal-suspending flows park for the
    /// run loop to hand the terminal over first.
    async fn handle_provider_auth_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        let action = {
            let Some(selector) = view.provider_auth.as_mut() else {
                return Ok(());
            };
            let kb = view.editor.keybindings();
            selector.handle_key(&id, kb)
        };
        match action {
            AuthSelectorAction::None => {}
            AuthSelectorAction::Cancel => {
                view.provider_auth = None;
            }
            AuthSelectorAction::LoginError { message } => {
                view.provider_auth = None;
                self.error_row(&message, view);
            }
            AuthSelectorAction::Login { provider, api_key } => {
                view.provider_auth = None;
                match api_key {
                    // The panel-prompted key: store it (TS
                    // `showApiKeyLoginDialog`'s save path, no terminal
                    // handover needed).
                    Some(api_key) => {
                        let auth = self.provider_auth.clone().expect("the selector was open");
                        let outcome = auth.0.login(&provider, Some(&api_key)).await;
                        self.apply_auth_outcome(outcome, view);
                    }
                    None => {
                        self.pending_terminal_login = Some(provider);
                    }
                }
            }
            AuthSelectorAction::Logout { provider } => {
                view.provider_auth = None;
                let auth = self.provider_auth.clone().expect("the selector was open");
                let outcome = auth.0.logout(&provider).await;
                self.apply_auth_outcome(outcome, view);
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// One flow outcome (TS `completeProviderAuthentication`'s status vs
    /// the flow's error row).
    fn apply_auth_outcome(
        &mut self,
        outcome: crate::provider_auth::ProviderAuthOutcome,
        view: &mut AgentView,
    ) {
        match outcome {
            crate::provider_auth::ProviderAuthOutcome::Status(message) => {
                self.note(&message, view);
            }
            crate::provider_auth::ProviderAuthOutcome::Error(message) => {
                self.error_row(&message, view);
            }
        }
    }

    /// Whether a provider login parked for the plain terminal (the run
    /// loop checks this after each key and hands the terminal over).
    pub(crate) fn pending_terminal_login(&self) -> bool {
        self.pending_terminal_login.is_some()
    }

    /// The run loop hands the terminal over and calls this for a parked
    /// terminal login flow (the TS auth panel prompts on the plain
    /// terminal; this build runs the composition root's flow there).
    pub(crate) async fn run_terminal_login(&mut self, view: &mut AgentView) -> Result<()> {
        let Some(provider) = self.pending_terminal_login.take() else {
            return Ok(());
        };
        let Some(auth) = self.provider_auth.clone() else {
            return Ok(());
        };
        let outcome = auth.0.login(&provider, None).await;
        self.apply_auth_outcome(outcome, view);
        self.dirty = true;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Update (/update)
    // ------------------------------------------------------------------

    /// Whether an update run parked for the run loop (the terminal handoff
    /// seam).
    pub(crate) fn pending_update(&self) -> bool {
        self.pending_update.is_some()
    }

    /// The parked update run (TS `handleUpdateCommand`'s child phase):
    /// run with the terminal handed over — package updates first, the
    /// self update last (it replaces this process on success). The
    /// relaunch preserves an explicit session selection, else it resumes
    /// this session by file.
    pub(crate) async fn run_update(&mut self, view: &mut AgentView) -> Result<()> {
        let Some(plan) = self.pending_update.take() else {
            return Ok(());
        };
        let Some(update) = self.update_commands.clone() else {
            self.note("/update is not available in this client yet", view);
            return Ok(());
        };
        if let Some(package) = &plan.package {
            let mut args = vec!["package".to_string(), "update".to_string()];
            match package {
                crate::update_command::PackageUpdate::All => args.push("--extensions".to_string()),
                crate::update_command::PackageUpdate::Source(source) => args.push(source.clone()),
            }
            match update.0.run_cli_child(args).await {
                Err(error) => {
                    self.error_row(&format!("Update failed: {error}"), view);
                    return Ok(());
                }
                Ok(code) if code != 0 => {
                    self.error_row(&format!("Update exited with code {code}"), view);
                    return Ok(());
                }
                Ok(_) => {}
            }
            if !plan.includes_self {
                // TS reloads resources after the child persisted settings;
                // `/reload` stays unported in this client.
                self.note("Packages updated. Reloading resources...", view);
                return Ok(());
            }
        }
        // The self-update child (TS passes the interactive-child marker;
        // the split CLI needs no target flags here).
        let mut args = vec!["update".to_string()];
        args.extend(plan.flags.clone());
        let child_result = update.0.run_cli_child(args).await;
        match child_result {
            Err(error) => {
                eprintln!("Update failed: {error}");
                eprintln!("Relaunching Prime Agent...");
            }
            Ok(code) if code != 0 => {
                eprintln!("Update exited with code {code}");
                eprintln!("Relaunching Prime Agent...");
            }
            Ok(_) => {}
        }
        // The relaunch (TS `buildUpdateRelaunchArgs`: this run's args plus
        // a session resume when the invocation did not select one).
        let mut relaunch_args: Vec<String> = std::env::args().skip(1).collect();
        if !crate::update_command::args_include_session_selection(&relaunch_args) {
            if let Some(session_file) = self.session_file.clone() {
                relaunch_args.push("--resume".to_string());
                relaunch_args.push(session_file);
            }
        }
        update.0.relaunch(relaunch_args)
    }

    // ------------------------------------------------------------------
    // Trace sharing (/traces)
    // ------------------------------------------------------------------

    /// `/traces` (TS `handleTracesCommand`): the status block, the
    /// enable/disable settings writes, and the TS command shapes. The
    /// upload subsystem (TS `core/agent-traces.ts`) is not ported yet, so
    /// the upload/preview/login arms report the TS state where the state
    /// decides it and their unavailability otherwise.
    async fn handle_traces_command(
        &mut self,
        resolved: &pa_types::slash_commands::ResolvedSlashCommand,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(traces) = self.traces.clone() else {
            self.note("/traces is not available in this client yet", view);
            return Ok(());
        };
        let command = resolved.args.trim().to_lowercase();
        let enabled = traces.0.enabled().await;
        let credential = traces.0.credential().await;
        let state = self.connection_state(view).await;
        let session_file = state
            .as_ref()
            .and_then(|state| state.get("sessionFile"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let outcome = crate::traces::traces_command(
            &command,
            enabled,
            credential.as_deref(),
            session_file.as_deref(),
            false,
        );
        match outcome {
            crate::traces::TracesOutcome::StatusBlock(rows) => {
                // TS `chatContainer.addChild(new Spacer(1))` then
                // `new Text(info, 1, 0)`: the info-display block the
                // `/session`-style commands share.
                view.push_entry(ChatEntry::ClientText { rows });
                self.dirty = true;
            }
            crate::traces::TracesOutcome::Status(text) => {
                match command.as_str() {
                    "off" | "disable" => {
                        if let Err(error) = traces.0.set_enabled(false).await {
                            self.error_row(
                                &format!("Trace sharing disabled write failed: {error:#}"),
                                view,
                            );
                            return Ok(());
                        }
                    }
                    "on" | "enable" => {
                        if let Err(error) = traces.0.set_enabled(true).await {
                            self.error_row(
                                &format!("Trace sharing enabled write failed: {error:#}"),
                                view,
                            );
                            return Ok(());
                        }
                    }
                    _ => {}
                }
                self.note(&text, view);
            }
            crate::traces::TracesOutcome::Warning(text) => {
                self.note_as(&text, StatusKind::Warning, view);
            }
            crate::traces::TracesOutcome::Error(text) => {
                self.error_row(&text, view);
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // Clipboard (/copy)
    // ------------------------------------------------------------------

    /// `/copy` (TS `handleCopyCommand`): fetch the last assistant text
    /// from the daemon and copy it to the clipboard. No assistant text
    /// yet is the TS error row; a clipboard failure surfaces the copy
    /// chain's own message.
    async fn handle_copy_command(&mut self, view: &mut AgentView) -> Result<()> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetLastAssistantText {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Default::default(),
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
            Ok(()) => self.note("Copied last agent message to clipboard", view),
            Err(message) => self.error_row(&message, view),
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // Settings (/settings)
    // ------------------------------------------------------------------

    /// `/settings` (TS `showSettingsSelector`): read the daemon state and
    /// the settings seam, then mount the menu.
    async fn open_settings_menu(&mut self, view: &mut AgentView) {
        let Some(state) = self.connection_state(view).await else {
            // The failure note already rendered.
            return;
        };
        let settings = self.client_settings.clone();
        let mut values = crate::settings_menu::SettingsCurrentValues {
            autocompact: state
                .get("autoCompactionEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            steering_mode: state
                .get("steeringMode")
                .and_then(Value::as_str)
                .unwrap_or("all")
                .to_string(),
            follow_up_mode: state
                .get("followUpMode")
                .and_then(Value::as_str)
                .unwrap_or("all")
                .to_string(),
            thinking_level: state
                .get("thinkingLevel")
                .and_then(Value::as_str)
                .map(str::to_string),
            available_thinking_levels: state
                .get("availableThinkingLevels")
                .and_then(Value::as_array)
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            ..Default::default()
        };
        // The settings-seam reads (TS `settingsManager` getters; the theme
        // default matches TS `getTheme() || "prime"`). A missing seam keeps
        // the TS defaults.
        if let Some(settings) = &settings {
            values.show_images = settings.show_images();
            values.auto_resize_images = settings.image_auto_resize();
            values.block_images = settings.block_images();
            values.skill_commands = settings.enable_skill_commands();
            values.builtin_skills = settings.enable_builtin_skills();
            values.hardware_cursor = settings.show_hardware_cursor();
            values.editor_padding = settings.editor_padding_x();
            values.autocomplete_max_visible = settings.autocomplete_max_visible();
            values.clear_on_shrink = settings.clear_on_shrink();
            values.terminal_progress = settings.show_terminal_progress();
            values.fullscreen = settings.fullscreen();
            values.idle_eviction_minutes = settings.idle_eviction_minutes();
            values.mermaid = settings.mermaid_rendering_mode();
            values.quiet_startup = settings.quiet_startup();
            values.tree_filter_mode = settings.tree_filter_mode();
            values.warnings_anthropic_extra_usage = settings.warnings_anthropic_extra_usage();
            values.theme = settings.theme().unwrap_or_else(|| "prime".to_string());
        } else {
            values.show_images = true;
            values.auto_resize_images = true;
            values.skill_commands = true;
            values.builtin_skills = true;
            values.fullscreen = self.fullscreen_enabled;
            values.idle_eviction_minutes = "90".to_string();
            values.mermaid = "streaming".to_string();
            values.tree_filter_mode = "user-only".to_string();
            values.warnings_anthropic_extra_usage = true;
            values.theme = "prime".to_string();
        }
        // The registered themes (TS `getAvailableThemes`; this surface
        // ships the builtins).
        values.available_themes = pa_types::themes::BUILTIN_THEME_NAMES
            .iter()
            .map(|name| name.to_string())
            .collect();
        let rows = crate::settings_menu::settings_menu_rows(&values);
        view.settings_menu = Some(crate::settings_menu::SettingsMenu::new(rows));
        self.dirty = true;
    }

    /// One key press while the settings menu is open (TS `SettingsList`
    /// callbacks reduced to actions the session applies).
    async fn handle_settings_menu_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        let action = {
            let Some(menu) = view.settings_menu.as_mut() else {
                return Ok(());
            };
            menu.handle_key(&id, view.editor.keybindings())
        };
        match action {
            crate::settings_menu::SettingsMenuAction::None => {}
            crate::settings_menu::SettingsMenuAction::Cancel => {
                view.settings_menu = None;
            }
            crate::settings_menu::SettingsMenuAction::PreviewTheme { name } => {
                // TS `onThemePreview`: switch live without persisting.
                view.theme = crate::app::load_theme(&name);
            }
            crate::settings_menu::SettingsMenuAction::RestoreTheme { name } => {
                // TS theme submenu cancel: preview the row's theme back.
                view.theme = crate::app::load_theme(&name);
            }
            crate::settings_menu::SettingsMenuAction::Change { id, value } => {
                self.apply_settings_change(id, &value, view).await;
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// One settings row's change (the TS `SettingsSelectorComponent`
    /// callback switch): daemon commands for session-owned switches, the
    /// settings seam for persisted preferences.
    async fn apply_settings_change(&mut self, id: &str, value: &str, view: &mut AgentView) {
        match id {
            "autocompact" => {
                self.daemon_switch(
                    DaemonCommand::SetAutoCompaction {
                        id: None,
                        active_session_id: self.active_session_id.clone(),
                        enabled: value == "true",
                        rest: Default::default(),
                    },
                    view,
                )
                .await;
            }
            "show-images" => {
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_show_images(value == "true") {
                        self.error_row(&format!("{error:#}"), view);
                        return;
                    }
                }
                // The live tool-card effect (TS re-flags every tool
                // component; the flag the view renders reads).
                self.show_images = value == "true";
                view.show_images = value == "true";
            }
            "auto-resize-images" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_image_auto_resize(enabled),
                    value,
                    view,
                );
            }
            "block-images" => {
                self.persist_bool_setting(
                    |settings, blocked| settings.set_block_images(blocked),
                    value,
                    view,
                );
            }
            "skill-commands" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_enable_skill_commands(enabled),
                    value,
                    view,
                );
            }
            "builtin-skills" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_enable_builtin_skills(enabled),
                    value,
                    view,
                );
                // TS fires `handleReloadCommand()` — the toggle takes
                // effect after a reload.
                let _ = self.handle_reload_command(view).await;
            }
            "show-hardware-cursor" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_show_hardware_cursor(enabled),
                    value,
                    view,
                );
            }
            "editor-padding" => {
                if let Some(settings) = &self.client_settings {
                    if let Ok(padding) = value.parse::<u64>() {
                        if let Err(error) = settings.set_editor_padding_x(padding) {
                            self.error_row(&format!("{error:#}"), view);
                        }
                    }
                }
            }
            "autocomplete-max-visible" => {
                if let Some(settings) = &self.client_settings {
                    if let Ok(max_visible) = value.parse::<u64>() {
                        if let Err(error) = settings.set_autocomplete_max_visible(max_visible) {
                            self.error_row(&format!("{error:#}"), view);
                        }
                    }
                }
            }
            "clear-on-shrink" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_clear_on_shrink(enabled),
                    value,
                    view,
                );
            }
            "terminal-progress" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_show_terminal_progress(enabled),
                    value,
                    view,
                );
            }
            "fullscreen" => {
                self.set_fullscreen_mode(value == "true", view);
            }
            "idle-eviction-minutes" => {
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_idle_eviction_minutes(value) {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            "steering-mode" => {
                self.daemon_switch(
                    DaemonCommand::SetSteeringMode {
                        id: None,
                        active_session_id: self.active_session_id.clone(),
                        mode: serde_json::Value::String(value.to_string()),
                        rest: Default::default(),
                    },
                    view,
                )
                .await;
            }
            "follow-up-mode" => {
                self.daemon_switch(
                    DaemonCommand::SetFollowUpMode {
                        id: None,
                        active_session_id: self.active_session_id.clone(),
                        mode: serde_json::Value::String(value.to_string()),
                        rest: Default::default(),
                    },
                    view,
                )
                .await;
            }
            "transport" => {
                let Ok(transport) = serde_json::from_value::<pa_types::ai::Transport>(
                    serde_json::Value::String(value.to_string()),
                ) else {
                    return;
                };
                self.daemon_switch(
                    DaemonCommand::SetTransport {
                        id: None,
                        active_session_id: self.active_session_id.clone(),
                        transport,
                        rest: Default::default(),
                    },
                    view,
                )
                .await;
            }
            "mermaid-rendering" => {
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_mermaid_rendering_mode(value) {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            "quiet-startup" => {
                self.persist_bool_setting(
                    |settings, quiet| settings.set_quiet_startup(quiet),
                    value,
                    view,
                );
            }
            "tree-filter-mode" => {
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_tree_filter_mode(value) {
                        self.error_row(&format!("{error:#}"), view);
                        return;
                    }
                }
                // The `/tree` selector reads the live field.
                self.tree_filter_mode = crate::tree_list::filter_mode_from_str(value);
            }
            "warnings-anthropic-extra-usage" => {
                self.persist_bool_setting(
                    |settings, enabled| settings.set_warnings_anthropic_extra_usage(enabled),
                    value,
                    view,
                );
            }
            "thinking" => {
                self.apply_thinking_level(value, view).await;
            }
            "theme" => {
                if let Some(settings) = &self.client_settings {
                    if let Err(error) = settings.set_theme(value) {
                        self.error_row(&format!("{error:#}"), view);
                        return;
                    }
                }
                view.theme = crate::app::load_theme(value);
            }
            other => {
                self.error_row(&format!("Unknown setting: {other}"), view);
            }
        }
    }

    /// Persist one boolean row through the settings seam, surfacing errors.
    fn persist_bool_setting(
        &mut self,
        set: impl FnOnce(&dyn crate::client_settings::ClientSettings, bool) -> anyhow::Result<()>,
        value: &str,
        view: &mut AgentView,
    ) {
        if let Some(settings) = &self.client_settings {
            if let Err(error) = set(settings.as_ref(), value == "true") {
                self.error_row(&format!("{error:#}"), view);
            }
        }
    }

    /// A session-switch daemon command (TS fire-and-forget with a
    /// `showError` catch): the result never blocks the menu.
    async fn daemon_switch(&mut self, command: DaemonCommand, view: &mut AgentView) {
        if let Err(error) = self
            .bounded_request(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), command)
            .await
        {
            self.error_row(&format!("{error:#}"), view);
        }
    }

    // ------------------------------------------------------------------
    // Fast mode, depth, fullscreen, and reload (/fast, /rlm-max-depth,
    // /fullscreen, /reload)
    // ------------------------------------------------------------------

    /// The catalog entry for the current model (the `/fast` eligibility
    /// check needs the provider and api, not just the id).
    fn current_model_entry(&self, view: &AgentView) -> Option<&pa_types::ai::Model> {
        let model_id = view.chrome.model_id.as_deref()?;
        self.model_catalog.iter().find(|model| model.id == model_id)
    }

    /// Recompute the `/fast` autocomplete filter (TS
    /// `getAvailableCommands` drops `/fast` when the current model is not
    /// fast-mode-eligible): call after every point the model id can move.
    fn update_fast_filter(&self, view: &mut AgentView) {
        let eligible = self
            .current_model_entry(view)
            .is_some_and(pa_types::ai::supports_fast_mode);
        let mut hidden = std::collections::HashSet::new();
        if !eligible {
            hidden.insert("fast".to_string());
        }
        view.editor.set_autocomplete_hidden_commands(hidden);
    }

    /// `/fast` (TS `handleFastCommand`): toggle the priority service tier.
    /// The TS queue (`fastModeToggleQueue`) serializes toggles; here the
    /// dispatch is the only submission path and awaits to completion, so
    /// toggles cannot interleave.
    async fn handle_fast_command(&mut self, view: &mut AgentView) {
        const UNAVAILABLE: &str = "Fast mode requires GPT-5.4, GPT-5.5, or GPT-5.6 with ChatGPT or OpenAI API key authentication";
        let eligible = self
            .current_model_entry(view)
            .is_some_and(pa_types::ai::supports_fast_mode);
        if !eligible {
            self.note(UNAVAILABLE, view);
            return;
        }
        // TS reads `connectionState.serviceTier` (priority = on) and flips
        // it; the refresh after the switch confirms the daemon's tier.
        let enabled = self.service_tier.as_deref() == Some("priority");
        let target = if enabled { "default" } else { "priority" };
        let tier = match serde_json::from_value::<pa_types::ai::ServiceTier>(
            serde_json::Value::String(target.to_string()),
        ) {
            Ok(tier) => tier,
            Err(error) => {
                self.error_row(&format!("{error:#}"), view);
                return;
            }
        };
        let switched = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::SetServiceTier {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    service_tier: Some(tier),
                    rest: Default::default(),
                },
            )
            .await;
        if let Err(error) = switched {
            self.error_row(&format!("{error:#}"), view);
            return;
        }
        // TS re-reads the state after the switch (`connection.getState()`)
        // and patches the local tier from the response.
        let state = self.connection_state(view).await;
        if let Some(state) = state {
            if let Some(tier) = state.get("serviceTier").and_then(Value::as_str) {
                self.service_tier = Some(tier.to_string());
            }
        }
        let on = self.service_tier.as_deref() == Some("priority");
        self.note(
            &format!("Fast mode: {}", if on { "on" } else { "off" }),
            view,
        );
    }

    /// `/rlm-max-depth` (TS `handleRlmMaxDepthCommand`): a missing
    /// argument reports the depth and its source; `<int> [--global]` sets
    /// the per-chat depth immediately and optionally the global default.
    async fn handle_rlm_max_depth_command(&mut self, view: &mut AgentView, args: &str) {
        let tokens: Vec<&str> = if args.is_empty() {
            Vec::new()
        } else {
            args.split_whitespace().collect()
        };
        if tokens.is_empty() {
            match self
                .bounded_request(
                    Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                    DaemonCommand::GetRlmMaxDepthStatus {
                        id: None,
                        active_session_id: self.active_session_id.clone(),
                        rest: Default::default(),
                    },
                )
                .await
            {
                Ok(data) => {
                    let depth = data.get("maxDepth").and_then(Value::as_u64).unwrap_or(0);
                    let source = data
                        .get("source")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    self.plain_row(&format!("RLM max depth: {depth} ({source})"), view);
                }
                Err(error) => self.error_row(&format!("{error:#}"), view),
            }
            return;
        }
        let global = tokens.get(1) == Some(&"--global");
        let valid = tokens.len() <= if global { 2 } else { 1 }
            && tokens[0].chars().all(|c| c.is_ascii_digit());
        if !valid {
            self.note_as(
                "Usage: /rlm-max-depth [<non-negative integer> [--global]]",
                StatusKind::Warning,
                view,
            );
            return;
        }
        let Ok(max_depth) = tokens[0].parse::<u64>() else {
            self.note_as(
                "RLM max depth must be a non-negative integer.",
                StatusKind::Warning,
                view,
            );
            return;
        };
        match self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::SetRlmMaxDepth {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    max_depth,
                    global: Some(global),
                    rest: Default::default(),
                },
            )
            .await
        {
            Ok(data) => {
                let saved = data
                    .get("globalSaved")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.plain_row(
                    &format!(
                        "RLM max depth set: {max_depth}{}",
                        if saved {
                            " and saved as global default"
                        } else {
                            ""
                        }
                    ),
                    view,
                );
                if let Some(error) = data.get("globalError").and_then(Value::as_str) {
                    self.error_row(
                        &format!("RLM max depth set for this chat, but the global default was not saved: {error}"),
                        view,
                    );
                }
            }
            Err(error) => self.error_row(&format!("{error:#}"), view),
        }
    }

    /// `/fullscreen` (TS `setFullscreenMode`): persist the preference and
    /// report the TS status row. This surface always renders on the
    /// alternate screen — the Rust TUI has no inline rendering mode yet
    /// (the main-screen rendering path is flagged for the TUI-polish
    /// lane) — so the toggle moves the persisted preference and the
    /// reported state; TS's non-TTY branch cannot trigger here because
    /// the surface draws its frames headless as well.
    fn set_fullscreen_mode(&mut self, enabled: bool, view: &mut AgentView) {
        if let Some(settings) = &self.client_settings {
            if let Err(error) = settings.set_fullscreen(enabled) {
                self.error_row(&format!("{error:#}"), view);
                return;
            }
        }
        self.fullscreen_enabled = enabled;
        view.fullscreen = enabled;
        let status = if enabled {
            let follow = view
                .editor
                .keybindings()
                .first_key("tui.viewport.follow")
                .map(|key| crate::keybindings::format_key_text(&key))
                .unwrap_or_else(|| "ctrl+shift+down".to_string());
            format!("Fullscreen rendering on — wheel/pageUp scroll, {follow} follows output")
        } else {
            "Fullscreen rendering off".to_string()
        };
        self.note(&status, view);
    }

    /// `/reload` (TS `handleReloadCommand`): the reload box replaces the
    /// editor (TS swaps the editor container) while the daemon reload
    /// runs; the run loop folds the outcome in when it lands.
    async fn handle_reload_command(&mut self, view: &mut AgentView) -> Result<()> {
        view.reload_box =
            Some("Reloading keybindings, extensions, skills, prompts, themes...".to_string());
        self.dirty = true;
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let notes = self.reload_notes.clone();
        let task = tokio::spawn(async move {
            let outcome = client
                .request_ok(DaemonCommand::Reload {
                    id: None,
                    active_session_id,
                    rest: Default::default(),
                })
                .await
                .map(|_| ())
                .map_err(|error| format!("{error:#}"));
            let _ = notes.send(outcome);
        });
        self.reload = Some(task);
        Ok(())
    }

    /// The `/reload` request settled (TS's post-reload client work): drop
    /// the box, re-read the user keybindings and theme, refresh the model
    /// catalog, and surface the TS status row.
    pub(crate) async fn apply_reload_outcome(&mut self, outcome: ReloadNote, view: &mut AgentView) {
        self.reload = None;
        view.reload_box = None;
        match outcome {
            Ok(()) => {
                // TS's reload re-mounts the editor container: client-side
                // transcript state resets and the view rebuilds from the
                // durable session store, so client status rows drop
                // exactly like the TS re-mount.
                self.rebuild_transcript(view).await;
                // TS `keybindings.reload()` + the startup editor/theme
                // re-reads; the Rust editor consumes the keybinding set,
                // so the reloaded manager replaces it.
                let mut keybindings = view.editor.keybindings().clone();
                keybindings.reload();
                view.editor.set_keybindings(keybindings);
                // TS re-applies the settings theme (`getTheme` -> `setTheme`);
                // an unknown name keeps the current theme (the startup
                // loader's fallback).
                if let Some(settings) = &self.client_settings {
                    if let Some(name) = settings.theme() {
                        view.theme = crate::app::load_theme(&name);
                    }
                }
                // TS `refreshConnectionCatalog`: the daemon's model catalog
                // re-fetch lands through the run loop's channel.
                self.spawn_model_catalog_refresh();
                // TS `showStatus`: tracked, so a back-to-back status
                // (e.g. the `/thinking` unavailable row) rewrites it in
                // place.
                self.note(
                    "Reloaded keybindings, extensions, skills, prompts, themes",
                    view,
                );
            }
            Err(error) => {
                self.error_row(&format!("Reload failed: {error}"), view);
            }
        }
        self.dirty = true;
    }

    /// Whether a `/reload` is in flight (the run loop must not end before
    /// its outcome row lands).
    pub(crate) fn reload_pending(&self) -> bool {
        self.reload.is_some()
    }

    // ------------------------------------------------------------------
    // Session export and share (/export, /share)
    // ------------------------------------------------------------------

    /// The TS `showError` row: `⚠ Error: <message>` in the error color.
    pub(crate) fn error_row(&mut self, message: &str, view: &mut AgentView) {
        view.push_entry(ChatEntry::Status {
            text: format!("\u{26a0} Error: {message}"),
            kind: StatusKind::Error,
        });
        self.dirty = true;
    }

    /// `/export [path]` (TS `handleExportCommand`): export the session to
    /// HTML — or, for an explicit `.jsonl` path, the current branch as a
    /// JSONL file — and report the written path. The daemon owns the
    /// export; failures surface as the TS error row.
    async fn handle_export_command(
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
        let request = if output_path
            .as_deref()
            .is_some_and(|path| path.ends_with(".jsonl"))
        {
            DaemonCommand::ExportJsonl {
                id: None,
                active_session_id: self.active_session_id.clone(),
                output_path,
                rest: Default::default(),
            }
        } else {
            DaemonCommand::ExportHtml {
                id: None,
                active_session_id: self.active_session_id.clone(),
                output_path,
                rest: Default::default(),
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
    async fn handle_share_command(&mut self, view: &mut AgentView) -> Result<()> {
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
                    rest: Default::default(),
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
    async fn handle_share_loader_key(&mut self, key: KeyEvent, view: &mut AgentView) -> Result<()> {
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

    // ------------------------------------------------------------------
    // Session-tree navigation (/tree, /fork, /clone)
    // ------------------------------------------------------------------

    /// Open the `/tree` selector over the session tree (TS
    /// `showTreeSelector`); `initial_selected` re-opens with the previous
    /// selection after a cancelled branch summary.
    async fn open_tree_selector(
        &mut self,
        view: &mut AgentView,
        initial_selected: Option<&str>,
    ) -> Result<()> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetSessionTree {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Default::default(),
                },
            )
            .await?;
        if data
            .get("flatNodes")
            .and_then(Value::as_array)
            .is_none_or(|nodes| nodes.is_empty())
        {
            self.note("No entries in session", view);
            return Ok(());
        }
        match TreeSelector::new(
            &data,
            view.terminal_rows(),
            self.branch_summary_skip_prompt,
            self.tree_filter_mode,
        ) {
            Some(mut selector) => {
                selector.set_initial_selection(initial_selected);
                view.tree_selector = Some(selector);
            }
            None => self.note("No entries in session", view),
        }
        self.dirty = true;
        Ok(())
    }

    /// One key press while the tree selector is open.
    async fn handle_tree_selector_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        let action = {
            let Some(selector) = view.tree_selector.as_mut() else {
                return Ok(());
            };
            let kb = view.editor.keybindings();
            selector.handle_key(kb, &id)
        };
        match action {
            TreeSelectorAction::None => {}
            TreeSelectorAction::Cancel => {
                view.tree_selector = None;
            }
            TreeSelectorAction::LabelChange { entry_id, label } => {
                let request = DaemonCommand::SetSessionEntryLabel {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    entry_id: entry_id.clone(),
                    label: label.clone(),
                    rest: Default::default(),
                };
                match self
                    .bounded_request(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), request)
                    .await
                {
                    Ok(_) => {
                        if let Some(selector) = view.tree_selector.as_mut() {
                            selector.update_label(&entry_id, label.as_deref());
                        }
                    }
                    Err(error) => self.note(&format!("{error:#}"), view),
                }
            }
            TreeSelectorAction::Navigate {
                target_id,
                summarize,
                custom_instructions,
            } => {
                // Selecting the current leaf is a no-op (TS).
                let leaf = view
                    .tree_selector
                    .as_ref()
                    .and_then(|selector| selector.current_leaf_id().map(str::to_string));
                view.tree_selector = None;
                if leaf.as_deref() == Some(target_id.as_str()) {
                    self.note("Already at this point", view);
                    self.dirty = true;
                    return Ok(());
                }
                self.navigate_tree(&target_id, summarize, custom_instructions, view)
                    .await?;
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// The `navigate_tree` request and its rendering (TS
    /// `_navigateTreeUnderPause` + `renderTreeNavigation`).
    async fn navigate_tree(
        &mut self,
        target_id: &str,
        summarize: bool,
        custom_instructions: Option<String>,
        view: &mut AgentView,
    ) -> Result<()> {
        let result = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS * 3),
                DaemonCommand::NavigateTree {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    target_id: target_id.to_string(),
                    summarize: Some(summarize),
                    custom_instructions,
                    replace_instructions: None,
                    label: None,
                    rest: Default::default(),
                },
            )
            .await;
        let data = match result {
            Ok(data) => data,
            Err(error) => {
                self.note(&format!("{error:#}"), view);
                return Ok(());
            }
        };
        if data.get("aborted").and_then(Value::as_bool) == Some(true) {
            // The branch summary was cancelled: re-open the tree selector
            // with the same selection (TS).
            self.note("Branch summarization cancelled", view);
            return self.open_tree_selector(view, Some(target_id)).await;
        }
        if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
            self.note("Navigation cancelled", view);
            return Ok(());
        }
        self.rebuild_transcript(view).await;
        // A user-message target re-enters its text in the editor when it is
        // empty (TS `renderTreeNavigation`).
        if let Some(editor_text) = data.get("editorText").and_then(Value::as_str) {
            if view.editor.get_text().trim().is_empty() {
                view.editor.set_text(editor_text);
            }
        }
        self.note("Navigated to selected point", view);
        self.dirty = true;
        Ok(())
    }

    /// Open the `/fork` selector over the session's user messages (TS
    /// `showUserMessageSelector`).
    async fn open_fork_selector(&mut self, view: &mut AgentView) -> Result<()> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetUserMessagesForForking {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Default::default(),
                },
            )
            .await?;
        let messages: Vec<crate::user_message_selector::UserMessageItem> = data
            .get("messages")
            .and_then(Value::as_array)
            .map(|messages| {
                messages
                    .iter()
                    .filter_map(|message| {
                        Some(crate::user_message_selector::UserMessageItem {
                            id: message.get("entryId")?.as_str()?.to_string(),
                            text: message.get("text")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if messages.is_empty() {
            self.note("No messages to fork from", view);
            return Ok(());
        }
        view.fork_selector = Some(UserMessageSelector::new(messages));
        self.dirty = true;
        Ok(())
    }

    /// One key press while the fork selector is open.
    async fn handle_fork_selector_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        let action = {
            let Some(selector) = view.fork_selector.as_mut() else {
                return Ok(());
            };
            let kb = view.editor.keybindings();
            selector.handle_key(kb, &id)
        };
        match action {
            UserMessageSelectorAction::Select(entry_id) => {
                view.fork_selector = None;
                self.fork(&entry_id, None, view).await?;
            }
            UserMessageSelectorAction::Cancel => {
                view.fork_selector = None;
            }
            UserMessageSelectorAction::None => {}
        }
        self.dirty = true;
        Ok(())
    }

    /// The `fork` request (TS `AgentSessionRuntime.fork`): the worker
    /// copies the path into a new session and switches to it.
    async fn fork(
        &mut self,
        entry_id: &str,
        position: Option<pa_types::daemon::ForkPosition>,
        view: &mut AgentView,
    ) -> Result<()> {
        let data = match self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS * 3),
                DaemonCommand::Fork {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    entry_id: entry_id.to_string(),
                    position,
                    rest: Default::default(),
                },
            )
            .await
        {
            Ok(data) => data,
            Err(error) => {
                self.note(&format!("fork failed: {error:#}"), view);
                return Ok(());
            }
        };
        if data.get("cancelled").and_then(Value::as_bool) == Some(true) {
            return Ok(());
        }
        self.rebuild_transcript(view).await;
        let selected_text = data.get("selectedText").and_then(Value::as_str);
        match selected_text {
            Some(text) => view.editor.set_text(text),
            None => view.editor.set_text(""),
        }
        self.note("Forked to new session", view);
        self.dirty = true;
        Ok(())
    }

    /// `/clone` (TS `handleCloneCommand`): fork at the current leaf.
    async fn handle_clone_command(&mut self, view: &mut AgentView) -> Result<()> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetSessionTree {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Default::default(),
                },
            )
            .await?;
        let Some(leaf_id) = data.get("leafId").and_then(Value::as_str) else {
            self.note("Nothing to clone yet", view);
            return Ok(());
        };
        if leaf_id.is_empty() {
            self.note("Nothing to clone yet", view);
            return Ok(());
        }
        self.fork(leaf_id, Some(pa_types::daemon::ForkPosition::At), view)
            .await?;
        self.note("Cloned to new session", view);
        self.dirty = true;
        Ok(())
    }

    /// The armed double-Escape action, taken once inside the window (TS
    /// `takeEscapeRepeatAction`).
    fn take_escape_repeat_action(&mut self) -> Option<&'static str> {
        let action = self.escape_repeat_action;
        if let Some(until) = self.escape_repeat_until {
            if Instant::now() < until {
                self.escape_repeat_action = None;
                self.escape_repeat_until = None;
                return action;
            }
        }
        self.escape_repeat_action = None;
        self.escape_repeat_until = None;
        None
    }

    /// Arm the double-Escape action for 500ms (TS `armEscapeRepeat`): the
    /// tree when the session is idle or the editor empty, the clear action
    /// otherwise.
    fn arm_escape_repeat(&mut self, action: &'static str) {
        self.escape_repeat_action = Some(action);
        self.escape_repeat_until = Some(Instant::now() + ESCAPE_REPEAT_WINDOW_MS);
    }

    /// `/mcp` (TS `handleMcpCommand`): the bare command opens the inline
    /// connections view over the daemon's roster (TS opens the
    /// configuration menu's MCP Connections tab); `login`/`logout <name>`
    /// run the composition root's auth flow (only the login prompts on
    /// the terminal, so `needs_terminal_suspension` covers it); anything
    /// else keeps the usage note.
    async fn handle_mcp_command(
        &mut self,
        resolved: &pa_types::slash_commands::ResolvedSlashCommand,
        view: &mut AgentView,
    ) -> Result<()> {
        self.track_command_used("mcp");
        if resolved.args.trim().is_empty() {
            return self.open_mcp_view(view).await;
        }
        let Some(auth) = self.client_auth.clone() else {
            self.note("/mcp is not available in this client yet", view);
            return Ok(());
        };
        let note = crate::client_auth::run_mcp_auth_command(auth.0.as_ref(), &resolved.args).await;
        self.note(&note, view);
        Ok(())
    }

    /// Open the inline `/mcp` connections view over the daemon's
    /// `get_mcp_connections` roster. The request carries the kernel's tool
    /// listing (it opens each connected generic server, bounded), so it
    /// gets the wider deadline.
    async fn open_mcp_view(&mut self, view: &mut AgentView) -> Result<()> {
        let data = match self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS * 4),
                DaemonCommand::GetMcpConnections {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Default::default(),
                },
            )
            .await
        {
            Ok(data) => data,
            Err(error) => {
                self.note(&format!("/mcp failed: {error:#}"), view);
                return Ok(());
            }
        };
        view.mcp_view = Some(crate::mcp_view::McpView::from_response(
            &data,
            picker_viewport_rows(view.terminal_rows()),
        ));
        self.dirty = true;
        Ok(())
    }

    /// One key press while the `/mcp` connections view is open: Esc or
    /// Ctrl+C close it; Enter resolves to the selected connection's login
    /// (dispatched as a client command after the key returns, so the auth
    /// flow keeps the terminal-suspension bracket); everything else
    /// navigates or edits the search field.
    async fn handle_mcp_view_key(&mut self, key: KeyEvent, view: &mut AgentView) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The view consumes Ctrl+C (close, not exit): report the handled
        // press so the force-quit guard can disarm once the whole pair was
        // consumed with TS semantics.
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let action = view
            .mcp_view
            .as_mut()
            .map(|mcp_view| mcp_view.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(crate::mcp_view::McpViewAction::None) => {}
            Some(crate::mcp_view::McpViewAction::Cancel) => {
                view.mcp_view = None;
                self.dirty = true;
            }
            Some(crate::mcp_view::McpViewAction::Select(server)) => {
                view.mcp_view = None;
                self.dirty = true;
                // TS `authenticate`: Enter runs the connection's login
                // flow — the same command path as `/mcp login <name>`.
                self.pending_client_command = Some(format!("/mcp login {server}"));
            }
            Some(crate::mcp_view::McpViewAction::Paste(server)) => {
                view.mcp_view = None;
                self.dirty = true;
                // The inline paste panel's client surface: prompt for the
                // token, store it bound to the service endpoint, verify.
                self.pending_client_command = Some(format!("/mcp paste {server}"));
            }
            None => {}
        }
        Ok(())
    }

    /// Whether dispatching this input needs the terminal handed over
    /// (raw-mode off, alternate screen left) so the auth flow can prompt.
    pub(crate) fn needs_terminal_suspension(&self, text: &str) -> bool {
        let Some((name, args)) = pa_types::slash_commands::parse_slash_command(text) else {
            return false;
        };
        if name != "mcp" || self.client_auth.is_none() {
            return false;
        }
        matches!(args.split_whitespace().next(), Some("login"))
    }

    /// `/resume <selector>`: a session file path, an `<id>.jsonl` under the
    /// sessions dir, or a live daemon session id (attach). Mirrors the CLI
    /// selector resolution in `interactive_mode.rs`.
    fn resolve_resume_selector(&self, selector: &str) -> Option<SessionSelection> {
        let selector = selector.trim();
        if selector.is_empty() {
            return None;
        }
        let path = std::path::Path::new(selector);
        if path.is_file() {
            return Some(SessionSelection::Resume(path.to_path_buf()));
        }
        if let Some(dir) = &self.session_dir {
            let candidate = dir.join(format!("{selector}.jsonl"));
            if candidate.is_file() {
                return Some(SessionSelection::Resume(candidate));
            }
        }
        Some(SessionSelection::Attach(selector.to_string()))
    }

    /// Options for `/new`: same socket, cwd, persistence, and script seam as
    /// the original run.
    fn create_options(&self) -> InteractiveOptions {
        InteractiveOptions {
            socket_path: self.client.socket_path().to_path_buf(),
            cwd: self.cwd.clone(),
            session_dir: self.session_dir.clone(),
            script_path: self.script_path.clone(),
            model_selection: self.model_selection.clone(),
            model_catalog: self.model_catalog.clone(),
            model_configured_providers: self.model_configured_providers.clone(),
            model_recent_models: self.model_recent_models.clone(),
            default_thinking_level: self.default_thinking_level.clone(),
            no_session: false,
            session: SessionSelection::New,
            initial_message: None,
            telemetry_disabled: self.telemetry_disabled,
            theme: String::new(),
            code_block_indent: self.code_block_indent.clone(),
            show_images: self.show_images,
            fullscreen_mouse: self.fullscreen_mouse,
            tree_filter_mode: self.tree_filter_mode.wire_name().to_string(),
            branch_summary_skip_prompt: self.branch_summary_skip_prompt,
            version: String::new(),
            onboarding: None,
            client_auth: self.client_auth.clone(),
            traces: self.traces.clone(),
            provider_auth: self.provider_auth.clone(),
            update_commands: self.update_commands.clone(),
            telemetry: self.telemetry.clone(),
            keybindings: self.keybindings.clone(),
            // The `/new` run keeps this process's stash store: a draft
            // stashed for the fresh session survives into the next chat
            // view that binds it.
            prompt_stash: self.prompt_stash.clone(),
            // `/new` starts a fresh root session: no depth label.
            session_rlm_depth: None,
            session_has_children: false,
            client_settings: self.client_settings.clone(),
        }
    }

    async fn refresh_list(&mut self, view: &mut AgentView) -> Result<()> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::List {
                    id: None,
                    all: None,
                    cwd: None,
                    session_dir: None,
                    include_client_owned: None,
                    rest: Default::default(),
                },
            )
            .await?;
        let sessions = data
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.list_rows = sorted_session_rows(sessions);
        let sessions = &self.list_rows;
        let mut lines = String::from("live sessions:");
        if sessions.is_empty() {
            lines.push_str("\n  (none)");
        }
        for (index, row) in sessions.iter().enumerate() {
            let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
            let current = if id == self.active_session_id {
                "*"
            } else {
                " "
            };
            let name = row
                .get("sessionName")
                .and_then(Value::as_str)
                .or_else(|| row.get("sessionId").and_then(Value::as_str))
                .unwrap_or_default();
            let activity = row
                .get("activity")
                .and_then(Value::as_str)
                .unwrap_or("idle");
            let cwd = row.get("cwd").and_then(Value::as_str).unwrap_or_default();
            lines.push_str(&format!(
                "\n{current} {}. {name} ({id}) {activity} {cwd}",
                index + 1
            ));
        }
        lines.push_str("\nswitch with /switch <n|id>");
        self.note(&lines, view);
        Ok(())
    }

    /// `/switch`: resolve the argument against the cached `/list` rows (1-based
    /// index or session id), then reattach.
    async fn switch_to(&mut self, target: &str, view: &mut AgentView) -> Result<()> {
        let id = match target.parse::<usize>() {
            Ok(index) => self
                .list_rows
                .get(index.wrapping_sub(1))
                .and_then(|row| row.get("id").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| target.to_string()),
            Err(_) => target.to_string(),
        };
        if id == self.active_session_id {
            self.note("already attached to that session", view);
            return Ok(());
        }
        // The draft in the editor belongs to the session being left: stash
        // it as that session's restore-on-reopen head and clear the editor,
        // so the switch lands on an empty prompt (the draft returns on a
        // switch back).
        self.stash_draft_for_switch(view);
        match self.attach_session(&id).await {
            Ok(()) => {
                self.rebuild_view(view);
                self.note(&format!("switched to session {id}"), view);
                // The switched-to session's own restore head (if one was
                // stashed earlier) lands after the switch note, so the
                // restore status is the row the back-to-back rewrite keeps
                // (TS `showStatus` last-wins).
                self.restore_prompt_stash_if_editor_empty(view);
            }
            Err(error) => {
                self.note(&format!("switch to {id} failed: {error:#}"), view);
            }
        }
        Ok(())
    }

    /// The Ctrl+C exit hint is armed (TS `isCtrlCExitHintVisible`): a
    /// second press inside the window terminates the client.
    fn ctrl_c_hint_visible(&self) -> bool {
        self.ctrl_c_hint_until
            .is_some_and(|until| Instant::now() < until)
    }

    /// Arm the Ctrl+C exit hint (TS `showCtrlCExitHint`).
    fn show_ctrl_c_hint(&mut self) {
        self.ctrl_c_hint_until = Some(Instant::now() + Duration::from_millis(CTRL_C_EXIT_HINT_MS));
    }

    /// Disarm the hint (TS `clearCtrlCExitHint`: escape, editing text, or
    /// shutdown).
    fn clear_ctrl_c_hint(&mut self) {
        self.ctrl_c_hint_until = None;
    }

    /// The tray override label while the exit hint is armed (TS
    /// `getTrayOverrideLabel`: `Press Ctrl+C again to exit`).
    pub(crate) fn tray_override(&self) -> Option<String> {
        if !self.ctrl_c_hint_visible() {
            return None;
        }
        let key = self
            .keybindings
            .first_key("app.clear")
            .map(|key| crate::keybindings::format_key_text(&key))
            .unwrap_or_else(|| "Ctrl+C".to_string());
        Some(format!("Press {key} again to exit"))
    }

    /// One key press while the `/model` picker is open: Esc/Ctrl+C close
    /// it without applying; Enter applies the selection.
    async fn handle_model_picker_key(&mut self, key: KeyEvent, view: &mut AgentView) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The picker consumes Ctrl+C (close, not exit): report the handled
        // press so the force-quit guard can disarm once the whole pair was
        // consumed with TS semantics.
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let action = view
            .model_picker
            .as_mut()
            .map(|picker| picker.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(ModelPickerAction::None) => {}
            Some(ModelPickerAction::Cancel) => {
                view.model_picker = None;
                self.dirty = true;
            }
            Some(ModelPickerAction::Apply(applied)) => {
                view.model_picker = None;
                self.apply_model_selection(&applied.provider, &applied.model_id, view)
                    .await;
                // A user-edited effort applies after the model switch (TS
                // `completeModelSelection`: `setModel`, then
                // `applyThinkingLevel` — the level row only on success).
                if let Some(level) = applied.effort {
                    self.apply_thinking_level(&level, view).await;
                }
            }
            None => {}
        }
        self.update_fast_filter(view);
        Ok(())
    }

    /// A mouse report (TS `handleFullscreenInput`'s selection branches):
    /// wheel turns scroll the transcript window by three lines; a left
    /// press starts a selection (transcript, or the dock's frame surface
    /// when the press is outside the window), a drag extends it with
    /// edge auto-scroll, and a release copies the spanned text out
    /// through OSC 52. Reports are consumed even while a picker, selector,
    /// or loader owns the frame (the TS overlay-focus gate) — the wheel
    /// never scrolls behind one, but its rows select; while tracking is
    /// inactive every report is consumed without a dispatch. The onboarding
    /// pane replaces the whole frame, so its runs consume reports without
    /// a selection surface (a known deviation from the TS inline block).
    pub(crate) fn handle_mouse(&mut self, event: crate::mouse::MouseEvent, view: &mut AgentView) {
        if !crate::mouse_tracking::active() {
            return;
        }
        if view.onboarding.is_some() {
            return;
        }
        // TS `isFullscreenOverlayFocused`: the `/model` and `/effort`
        // pickers, the `/tree` and `/fork` selectors, the `/mcp`
        // connections view, and the `/share` loader own the frame like the
        // TS overlays.
        let overlay_focused = view.model_picker.is_some()
            || view.effort_picker.is_some()
            || view.heartbeats_picker.is_some()
            || view.tree_selector.is_some()
            || view.fork_selector.is_some()
            || view.share_loader.is_some()
            || view.mcp_view.is_some();
        // Wheel turns scroll only on the session surface; a pane owns the
        // frame, the turn is consumed without scrolling.
        if let Some(delta) = crate::mouse::wheel_scroll_delta(&event) {
            if !overlay_focused {
                view.scroll_by(delta);
                self.dirty = true;
            }
            return;
        }
        // Screen cells are one-based in the report (TS passes `event.y - 1`).
        let row = event.y.saturating_sub(1) as usize;
        let col = event.x.saturating_sub(1) as usize;
        let left_press = event.press && event.button == crate::mouse::BUTTON_LEFT;
        if overlay_focused {
            // TS tries the frame surface first while an overlay owns the
            // frame (its rows are the selectable spans), then the window.
            self.stop_selection_auto_scroll();
            if left_press && !event.motion {
                if !view.begin_frame_selection(row, col) {
                    view.begin_selection(row, col);
                }
                self.dirty = true;
            } else if left_press && event.motion {
                view.extend_active_selection(row, col);
                self.dirty = true;
            } else if !event.press && view.has_selection() {
                let text = view.end_active_selection();
                if let Some(text) = text {
                    self.copy_selection(&text, view);
                }
                self.dirty = true;
            } else if !event.press {
                view.clear_selection();
            }
            return;
        }
        if left_press && !event.motion {
            self.stop_selection_auto_scroll();
            // TS `beginSelection` then the `beginFrameSelection` fallback.
            if !view.begin_selection(row, col) {
                view.begin_frame_selection(row, col);
            }
            self.dirty = true;
        } else if left_press && event.motion {
            view.extend_active_selection(row, col);
            self.update_selection_auto_scroll(view, row, col);
            self.dirty = true;
        } else if !event.press && view.has_selection() {
            self.stop_selection_auto_scroll();
            let text = view.end_active_selection();
            if let Some(text) = text {
                self.copy_selection(&text, view);
            }
            self.dirty = true;
        } else if !event.press {
            self.stop_selection_auto_scroll();
            view.clear_selection();
        }
    }

    /// Copy a finished selection out (TS `copySelection` +
    /// `copyFullscreenSelection`): OSC 52 works locally, over SSH, and
    /// through tmux (`set-clipboard`), so the write goes straight to the
    /// terminal; a headless run has no terminal and records the text for
    /// its verifier instead. A successful copy surfaces the
    /// "Copied selection to clipboard" status row (TS `showStatus`), a
    /// failed write the failure row (TS `showError`).
    fn copy_selection(&mut self, text: &str, view: &mut AgentView) {
        let lines = text.lines().count().max(1);
        self.copies.push(text.to_string());
        self.track_selection(lines);
        if !std::io::IsTerminal::is_terminal(&std::io::stdout()) {
            self.note("Copied selection to clipboard", view);
            return;
        }
        use base64::Engine;
        use std::io::Write;
        let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        let mut out = std::io::stdout();
        match out.write_all(format!("\x1b]52;c;{encoded}\x07").as_bytes()) {
            Ok(()) => {
                let _ = out.flush();
                self.note("Copied selection to clipboard", view);
            }
            Err(error) => {
                self.error_row(&format!("Failed to copy selection: {error}"), view);
            }
        }
    }

    /// Arm, re-aim, or disarm the selection auto-scroll for a drag position
    /// (TS `updateSelectionAutoScroll`).
    fn update_selection_auto_scroll(&mut self, view: &AgentView, row: usize, col: usize) {
        match view.selection_auto_scroll_direction(row) {
            Some(direction) => match &mut self.selection_auto_scroll {
                Some(armed) if armed.direction == direction => {
                    armed.row = row;
                    armed.col = col;
                }
                _ => {
                    self.selection_auto_scroll = Some(SelectionAutoScroll {
                        direction,
                        row,
                        col,
                        started: Instant::now(),
                    })
                }
            },
            None => self.selection_auto_scroll = None,
        }
    }

    /// Stop the selection auto-scroll (TS `stopSelectionAutoScroll`): every
    /// non-drag input and each scroll edge case disarms it.
    pub(crate) fn stop_selection_auto_scroll(&mut self) {
        self.selection_auto_scroll = None;
    }

    /// One idle tick of the selection auto-scroll (the run loop's 50 ms arm
    /// stands in for TS's timer): after the 150 ms hold window, each tick
    /// scrolls one line set and re-aims the head onto the edge row; the
    /// drag ending, the edge direction changing, or the scroll clamping
    /// disarms the driver.
    pub(crate) fn selection_auto_scroll_tick(&mut self, view: &mut AgentView) {
        let Some(armed) = self.selection_auto_scroll.clone() else {
            return;
        };
        if Instant::now().duration_since(armed.started) < SELECTION_AUTO_SCROLL_DELAY {
            return;
        }
        if view.selection_auto_scroll_direction(armed.row) != Some(armed.direction)
            || !view.scroll_selection(armed.direction, armed.col)
        {
            self.selection_auto_scroll = None;
            return;
        }
        self.dirty = true;
    }

    /// A bracketed paste (TS routes terminal paste into the focused input):
    /// an open `/model` picker pastes into its search field; otherwise the
    /// editor takes it.
    pub(crate) fn handle_paste(&mut self, text: &str, view: &mut AgentView) {
        if let Some(picker) = view.model_picker.as_mut() {
            picker.paste(text);
            self.dirty = true;
            return;
        }
        if let Some(mcp_view) = view.mcp_view.as_mut() {
            mcp_view.paste(text);
            self.dirty = true;
            return;
        }
        let _ = view.editor.handle_paste(text);
    }

    /// One key press while the `/effort` picker is open: Esc/Ctrl+C close
    /// it without applying; Enter applies the picked level.
    async fn handle_effort_picker_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The picker consumes Ctrl+C (close, not exit): report the handled
        // press so the force-quit guard can disarm once the whole pair was
        // consumed with TS semantics.
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let action = view
            .effort_picker
            .as_mut()
            .map(|picker| picker.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(EffortPickerAction::None) => {}
            Some(EffortPickerAction::Cancel) => {
                view.effort_picker = None;
                self.dirty = true;
            }
            Some(EffortPickerAction::Apply { level }) => {
                view.effort_picker = None;
                self.apply_thinking_level(&level, view).await;
            }
            None => {}
        }
        Ok(())
    }

    /// One key press while the `/heartbeats` view is open: Esc/Ctrl+C/close
    /// binding close it; Enter on the list opens the selected heartbeat's
    /// action pane; Enter on an action runs the management request.
    async fn handle_heartbeats_picker_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The view consumes Ctrl+C (close, not exit): report the handled
        // press so the force-quit guard can disarm once the whole pair was
        // consumed with TS semantics.
        if id == "ctrl+c" {
            self.exit_guard.note_ctrl_c_handled();
        }
        let action = view
            .heartbeats_picker
            .as_mut()
            .map(|picker| picker.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(HeartbeatsPickerAction::None) => {
                self.dirty = true;
            }
            Some(HeartbeatsPickerAction::Close) => {
                view.heartbeats_picker = None;
                self.dirty = true;
            }
            Some(HeartbeatsPickerAction::Manage {
                active_session_id,
                job_id,
                action,
            }) => {
                self.run_heartbeat_manage(active_session_id, job_id, action, view)
                    .await;
            }
            None => {}
        }
        Ok(())
    }

    /// Run one heartbeat management request (TS `manageHeartbeat` →
    /// `agentConnection.manageHeartbeat`): the daemon owns the job; the
    /// updated job (or the stop's removal) patches the open view locally,
    /// a background refresh reconciles the catalog, and a failure
    /// surfaces as the view's error row.
    async fn run_heartbeat_manage(
        &mut self,
        active_session_id: String,
        job_id: String,
        action: HeartbeatAction,
        view: &mut AgentView,
    ) {
        let request = DaemonCommand::HeartbeatManage {
            id: None,
            active_session_id,
            job_id,
            action: Value::String(action.as_wire().to_string()),
            rest: Default::default(),
        };
        match self
            .bounded_request(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), request)
            .await
        {
            Ok(data) => {
                // The daemon returns the updated job (a stop keeps the
                // cancelled row's identity); a patch that cannot parse still
                // leaves the actions pane, and the refresh reconciles.
                match data
                    .get("heartbeat")
                    .and_then(crate::heartbeats_picker::parse_heartbeat_job)
                {
                    Some(job) => {
                        let stopped = action == HeartbeatAction::Stop;
                        let job_id = job.id.clone();
                        if let Some(picker) = view.heartbeats_picker.as_mut() {
                            picker.apply_managed_job(job.clone(), stopped);
                        }
                        // The tray label follows the same patch the manager
                        // view applied (TS `manageHeartbeat` rewrites the
                        // catalog entry, not just the open manager).
                        if stopped {
                            self.heartbeat_catalog
                                .retain(|entry| entry.job.id != job_id);
                        } else if let Some(entry) = self
                            .heartbeat_catalog
                            .iter_mut()
                            .find(|entry| entry.job.id == job_id)
                        {
                            entry.job = job;
                        }
                    }
                    None => {
                        if let Some(picker) = view.heartbeats_picker.as_mut() {
                            picker.back_to_list();
                        }
                    }
                }
                self.sync_heartbeat_tray(view);
                self.spawn_heartbeat_refresh();
                self.dirty = true;
            }
            Err(error) => {
                if let Some(picker) = view.heartbeats_picker.as_mut() {
                    picker.set_action_error(format!("{error:#}"));
                }
                self.dirty = true;
            }
        }
    }

    /// Fetch the session-scoped heartbeat catalog (TS
    /// `refreshHeartbeatCatalog`'s fetch + `getScopedHeartbeats`): the
    /// selector-less supervisor catalog, scoped to this session and its
    /// live RLM children, sorted, or the fetch error that replaces it.
    async fn fetch_scoped_heartbeats(&self) -> (Vec<HeartbeatEntry>, Option<String>) {
        let request = DaemonCommand::HeartbeatsList {
            id: None,
            active_session_id: None,
            rest: Default::default(),
        };
        match self
            .bounded_request(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), request)
            .await
        {
            Ok(data) => {
                let mut heartbeats = self.scope_heartbeats(parse_heartbeats(&data));
                sort_heartbeats(&mut heartbeats);
                (heartbeats, None)
            }
            Err(error) => (Vec::new(), Some(format!("{error:#}"))),
        }
    }

    /// Scope a fetched catalog to this session and its roster descendants
    /// (TS `scopeHeartbeatsToSession` over the RLM child snapshots).
    fn scope_heartbeats(&self, heartbeats: Vec<HeartbeatEntry>) -> Vec<HeartbeatEntry> {
        let identity = crate::subagents::SessionIdentity::new(
            (!self.active_session_id.is_empty()).then(|| self.active_session_id.clone()),
            (!self.session_id.is_empty()).then(|| self.session_id.clone()),
            self.session_file.clone(),
        );
        let summaries: Vec<&Value> = self.roster.iter().collect();
        let child_active_session_ids: Vec<String> =
            crate::subagents::descendant_positions(&summaries, &identity)
                .into_iter()
                .filter_map(|position| {
                    summaries[position]
                        .get("activeSessionId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect();
        scope_heartbeats(
            heartbeats,
            identity.active_session_id.as_deref(),
            identity.session_id.as_deref(),
            &child_active_session_ids,
        )
    }

    /// Fire a background heartbeat-catalog refresh (TS
    /// `refreshHeartbeatCatalog`): the fetch lands through the run loop's
    /// channel into the open view; failures clear nothing — the next
    /// `heartbeats_changed` event retries.
    pub(crate) fn spawn_heartbeat_refresh(&self) {
        let updates = self.heartbeat_updates.clone();
        let client = self.client.clone();
        tokio::spawn(async move {
            let request = DaemonCommand::HeartbeatsList {
                id: None,
                active_session_id: None,
                rest: Default::default(),
            };
            let fetched = tokio::time::timeout(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                client.request_ok(request),
            )
            .await;
            match fetched {
                Ok(Ok(data)) => {
                    let _ = updates.send(HeartbeatsUpdate {
                        heartbeats: parse_heartbeats(&data),
                        fetch_error: None,
                    });
                }
                Ok(Err(error)) => {
                    let _ = updates.send(HeartbeatsUpdate {
                        heartbeats: Vec::new(),
                        fetch_error: Some(format!("{error:#}")),
                    });
                }
                Err(_) => {
                    let _ = updates.send(HeartbeatsUpdate {
                        heartbeats: Vec::new(),
                        fetch_error: Some(
                            "timed out waiting for the Prime Agent daemon response".to_string(),
                        ),
                    });
                }
            }
        });
    }

    /// Fold a landed heartbeat-catalog refresh into the session: re-scope
    /// and re-sort, keep the open view's selection, surface the fetch
    /// error, and re-sync the tray label (TS `applyHeartbeatCatalog` over
    /// both the manager and the tray's `getTrayHeartbeatLabel`).
    pub(crate) fn apply_heartbeat_update(
        &mut self,
        update: HeartbeatsUpdate,
        view: &mut AgentView,
    ) {
        let mut heartbeats = self.scope_heartbeats(update.heartbeats);
        sort_heartbeats(&mut heartbeats);
        self.heartbeat_catalog = heartbeats.clone();
        if let Some(picker) = view.heartbeats_picker.as_mut() {
            picker.apply_catalog(heartbeats, update.fetch_error);
        }
        self.sync_heartbeat_tray(view);
        self.dirty = true;
    }

    /// Fetch the scoped catalog and open the `/heartbeats` view over it
    /// (TS `showHeartbeatManager`): the fetch error replaces an empty
    /// list, and the tray label follows the landed catalog.
    async fn open_heartbeats_view(&mut self, view: &mut AgentView) {
        let (heartbeats, fetch_error) = self.fetch_scoped_heartbeats().await;
        self.heartbeat_catalog = heartbeats.clone();
        view.heartbeats_picker = Some(HeartbeatsPicker::new(
            heartbeats,
            fetch_error,
            picker_viewport_rows(view.terminal_rows()),
        ));
        self.sync_heartbeat_tray(view);
        self.dirty = true;
    }

    /// The tray heartbeat label follows the scoped catalog (TS
    /// `getTrayHeartbeatLabel`): `N heartbeats · M paused (Ctrl+R)`.
    pub(crate) fn sync_heartbeat_tray(&mut self, view: &mut AgentView) {
        let label = tray_heartbeat_label(&self.heartbeat_catalog, &self.keybindings);
        if view.chrome.heartbeat_label != label {
            view.chrome.heartbeat_label = label;
            self.dirty = true;
        }
    }

    /// The session's current model, matched against the picker catalog (the
    /// daemon state reports the id; the catalog entry supplies the
    /// provider).
    fn current_model(&self, view: &AgentView) -> Option<CurrentModel> {
        let model_id = view.chrome.model_id.as_deref()?;
        let model = self
            .model_catalog
            .iter()
            .find(|model| model.id == model_id)?;
        Some(CurrentModel {
            provider: model.provider.clone(),
            model_id: model.id.clone(),
        })
    }

    /// Fire a background `get_model_catalog` refresh (TS
    /// `getModelSelectorRefreshPromise` + `getConnectionAvailableModels`):
    /// the response lands through the run loop's channel, and failures
    /// leave the current snapshot alone.
    pub(crate) fn spawn_model_catalog_refresh(&self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let updates = self.catalog_updates.clone();
        tokio::spawn(async move {
            let Ok(value) = client
                .request_ok(DaemonCommand::GetModelCatalog {
                    id: None,
                    active_session_id,
                    rest: Default::default(),
                })
                .await
            else {
                // TS startup fetches fail silently (`getModelCandidates`
                // catches); the menu-open refresh surfaces the error only
                // while the menu is open, and the picker catalogs stay as
                // they are.
                return;
            };
            let models: Vec<pa_types::ai::Model> = value
                .get("models")
                .cloned()
                .and_then(|models| serde_json::from_value(models).ok())
                .unwrap_or_default();
            let configured_providers: std::collections::HashSet<String> = value
                .get("configuredProviders")
                .and_then(Value::as_array)
                .map(|providers| {
                    providers
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let _ = updates.send(ModelCatalogUpdate {
                models,
                configured_providers,
            });
        });
    }

    /// Whether the catalog refresh is due (TS `getModelSelectorRefreshPromise`:
    /// forced, never fetched, or older than the TTL).
    pub(crate) fn model_refresh_due(&self, force: bool) -> bool {
        force
            || match self.models_fetched_at {
                None => true,
                Some(fetched) => fetched.elapsed() > MODEL_CATALOG_REFRESH_TTL,
            }
    }

    /// Fold a landed catalog refresh into the session and any open picker
    /// (TS `applyConnectionModelCatalog` + the menu's `updateModels`).
    pub(crate) fn apply_model_catalog(&mut self, update: ModelCatalogUpdate, view: &mut AgentView) {
        self.model_catalog = update.models;
        self.model_configured_providers = update.configured_providers;
        self.models_fetched_at = Some(std::time::Instant::now());
        let current = self.current_model(view);
        if let Some(picker) = view.model_picker.as_mut() {
            picker.update_state(
                current,
                self.model_catalog.clone(),
                self.model_configured_providers.clone(),
            );
        }
        self.update_fast_filter(view);
        self.dirty = true;
    }

    /// The picker's effort seed (TS `showConfigurationMenu`'s `thinkingLevel`
    /// option): the session's live level for a reasoning current model,
    /// else the settings default (`"medium"` when unset).
    async fn picker_initial_thinking_level(
        &mut self,
        current: Option<&CurrentModel>,
        view: &mut AgentView,
    ) -> Option<pa_types::ai::ModelThinkingLevel> {
        let reasoning = current.and_then(|current| {
            self.model_catalog
                .iter()
                .find(|model| model.provider == current.provider && model.id == current.model_id)
                .map(|model| model.reasoning)
        });
        if reasoning == Some(true) {
            let level = self
                .connection_state(view)
                .await
                .as_ref()
                .and_then(|state| state.get("thinkingLevel"))
                .and_then(Value::as_str)
                .and_then(pa_types::ai::thinking_level_from_str);
            return level;
        }
        self.default_thinking_level
            .as_deref()
            .and_then(pa_types::ai::thinking_level_from_str)
            .or(Some(pa_types::ai::ModelThinkingLevel::Medium))
    }

    /// Apply a picked model (TS `applySelectedModel` + the
    /// `completeModelSelection` status row): the daemon `set_model` command
    /// switches the live session — the agent, the provider target, and the
    /// session's settings default follow — then the client refreshes its
    /// model label and records the `Model: <id>` status row. A failure
    /// surfaces as the error note instead.
    async fn apply_model_selection(
        &mut self,
        provider: &str,
        model_id: &str,
        view: &mut AgentView,
    ) {
        let switched = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::SetModel {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    provider: provider.to_string(),
                    model_id: model_id.to_string(),
                    rest: Default::default(),
                },
            )
            .await;
        match switched {
            Ok(_) => {
                // The create path's runtime config carries the picked model,
                // so `/new` sessions start on it too (TS settings default).
                self.model_selection.provider = Some(provider.to_string());
                self.model_selection.model = Some(model_id.to_string());
                self.refresh_model_label(model_id, view).await;
                self.note(&format!("Model: {model_id}"), view);
            }
            Err(error) => {
                // TS `showError`: the ⚠ Error row with the error tone.
                view.push_entry(ChatEntry::Status {
                    text: format!("\u{26a0} Error: {error:#}"),
                    kind: StatusKind::Error,
                });
                self.dirty = true;
            }
        }
    }

    /// Apply a thinking level (TS `applyThinkingLevel`): the daemon
    /// `set_thinking_level` command switches the session's level (durable
    /// row and settings default included), then the client records the
    /// `Thinking level: <level>` status row.
    async fn apply_thinking_level(&mut self, level: &str, view: &mut AgentView) {
        let switched = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::SetThinkingLevel {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    level: level.to_string(),
                    rest: Default::default(),
                },
            )
            .await;
        match switched {
            Ok(_) => self.note(&format!("Thinking level: {level}"), view),
            Err(error) => {
                // TS `showError`: the ⚠ Error row with the error tone.
                view.push_entry(ChatEntry::Status {
                    text: format!("\u{26a0} Error: {error:#}"),
                    kind: StatusKind::Error,
                });
                self.dirty = true;
            }
        }
    }

    /// The session's connection state (TS `AgentConnectionState`): the
    /// worker's `get_state` response. `None` surfaces the failure as a
    /// note; callers keep the transcript unchanged then.
    async fn connection_state(&mut self, view: &mut AgentView) -> Option<Value> {
        match self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetState {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Default::default(),
                },
            )
            .await
        {
            Ok(data) => Some(data),
            Err(error) => {
                self.note(&format!("{error:#}"), view);
                None
            }
        }
    }

    /// Refresh the chrome model label after a live switch (TS
    /// `applySelectedModel` reads the state and patches the footer via
    /// `applyModelSwitchUiState`): the state's model wins, and a state
    /// that omits it falls back to the picked model (`state.model ??
    /// fallbackModel`) — the switch already succeeded, so the label must
    /// move even when the worker's summary cannot re-resolve the model.
    async fn refresh_model_label(&mut self, picked_model_id: &str, view: &mut AgentView) {
        let state = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetState {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Default::default(),
                },
            )
            .await;
        if let Ok(data) = state {
            let model_id = data
                .get("model")
                .and_then(|model| model.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| picked_model_id.to_string());
            view.chrome.model_id = Some(model_id);
            self.dirty = true;
        }
    }

    /// Abort the active turn off the UI loop (TS `interruptOrClearInput`
    /// fires `void abort()`): the request never blocks key handling, and a
    /// failure surfaces later as a transcript note.
    fn abort_turn(&self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let notes = self.notes.clone();
        tokio::spawn(async move {
            let result = client
                .request_ok(DaemonCommand::Abort {
                    id: None,
                    active_session_id,
                    rest: Default::default(),
                })
                .await;
            if let Err(error) = result {
                let _ = notes.send(format!("the abort failed: {error:#}"));
            }
        });
    }

    /// Cancel the in-flight compaction off the UI loop (TS
    /// `interruptOrClearInput` fires `abortCompaction()` when the
    /// compaction loader is up — the agent is not streaming during a
    /// compaction, so the interrupt cancels the run, not a turn): the
    /// request never blocks key handling, and a failure surfaces later
    /// as a transcript note.
    fn abort_compaction(&self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let notes = self.notes.clone();
        tokio::spawn(async move {
            let result = client
                .request_ok(DaemonCommand::AbortCompaction {
                    id: None,
                    active_session_id,
                    rest: Default::default(),
                })
                .await;
            if let Err(error) = result {
                let _ = notes.send(format!("the compaction abort failed: {error:#}"));
            }
        });
    }

    /// Apply one background note (a failed abort request) to the transcript.
    pub(crate) fn apply_background_note(&mut self, text: &str, view: &mut AgentView) {
        self.note(text, view);
    }

    /// A compaction succeeded and the durable transcript was rebuilt (it
    /// now starts at the compaction summary): re-fetch it and replace the
    /// view's chat (TS `rebuildChatFromMessages`). Best effort — a failed
    /// fetch keeps the pushed outcome row instead of an empty transcript.
    pub(crate) async fn rebuild_transcript(&mut self, view: &mut AgentView) {
        self.transcript_stale = false;
        // The rebuilt transcript invalidates the tracked status row.
        self.last_status_index = None;
        let Ok(data) = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetMessages {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Default::default(),
                },
            )
            .await
        else {
            return;
        };
        let Some(messages) = data.get("messages").and_then(Value::as_array) else {
            return;
        };
        let entries = crate::snapshot::transcript_to_entries(messages);
        view.clear_chat();
        for entry in entries {
            view.push_entry(entry);
        }
        view.follow();
        self.dirty = true;
    }

    /// The `tui exit` reason recorded at the point the loop stopped.
    pub(crate) fn exit_reason(&self) -> &'static str {
        self.exit_reason
    }

    /// Report the first scroll action of the run (`tui scroll used`),
    /// fire-and-forget so the keypress never waits on the telemetry flush.
    fn track_scroll(&mut self, action: &'static str, resumed_following: bool) {
        if self.scroll_adoption_emitted {
            return;
        }
        self.scroll_adoption_emitted = true;
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.scroll_used(action, resumed_following).await;
            });
        }
    }

    /// Report the run's first selection copy (`tui selection used`),
    /// fire-and-forget like the scroll event: the release never waits on
    /// the telemetry flush. `lines` is the copied text's line count.
    fn track_selection(&mut self, lines: usize) {
        if self.selection_adoption_emitted {
            return;
        }
        self.selection_adoption_emitted = true;
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.selection_used(lines).await;
            });
        }
    }

    /// Take a pending `app.suspend` request (TS `handleCtrlZ`): the
    /// interactive loop performs the process-group suspend cycle; only
    /// the loop owns the renderer that hands the terminal over.
    pub(crate) fn take_suspend_request(&mut self) -> bool {
        std::mem::take(&mut self.suspend_requested)
    }

    /// Take the pending client command a selector resolved to (the `/mcp`
    /// view's Enter): the interactive loop dispatches it through the
    /// ordinary submit path, so the auth flows keep the suspend bracket.
    pub(crate) fn take_pending_client_command(&mut self) -> Option<String> {
        self.pending_client_command.take()
    }

    /// Report the run's first suspend cycle (`tui suspend used`),
    /// fire-and-forget like the scroll event: the keypress never waits on
    /// the telemetry flush. `outcome` is `resumed` (the SIGCONT
    /// continuation restored the terminal) or `failed` (the cycle errored).
    pub(crate) fn track_suspend_used(&mut self, outcome: &'static str) {
        if self.suspend_adoption_emitted {
            return;
        }
        self.suspend_adoption_emitted = true;
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.suspend_used(outcome).await;
            });
        }
    }

    /// Report a builtin client-command submission (`agent command used`),
    /// fire-and-forget like the scroll event: the command's handling never
    /// waits on the telemetry flush.
    fn track_command_used(&mut self, command: &'static str) {
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.command_used(command).await;
            });
        }
    }

    pub(crate) async fn handle_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
        running: &mut bool,
    ) -> Result<()> {
        // The `/model` picker owns the frame while open: every key goes to
        // it, before the editor, the viewport keys, or Ctrl+C (which
        // cancels the picker instead of aborting a turn).
        if view.model_picker.is_some() {
            return self.handle_model_picker_key(key, view).await;
        }
        // The `/effort` picker owns the frame the same way.
        if view.effort_picker.is_some() {
            return self.handle_effort_picker_key(key, view).await;
        }
        // The `/mcp` connections view owns the frame the same way.
        if view.mcp_view.is_some() {
            return self.handle_mcp_view_key(key, view).await;
        }
        // The `/heartbeats` view owns the frame the same way.
        if view.heartbeats_picker.is_some() {
            return self.handle_heartbeats_picker_key(key, view).await;
        }
        // The `/tree` and `/fork` selectors own the frame the same way.
        if view.tree_selector.is_some() {
            return self.handle_tree_selector_key(key, view).await;
        }
        if view.fork_selector.is_some() {
            return self.handle_fork_selector_key(key, view).await;
        }
        // A pending extension confirm owns the frame the same way (TS
        // `showExtensionConfirm` mounts its selector over the prompt).
        if view.confirm.is_some() {
            return self.handle_confirm_key(key, view).await;
        }
        // The `/login` / `/logout` provider selector owns the frame the
        // same way (TS's auth panel mounts over the prompt).
        if view.provider_auth.is_some() {
            return self.handle_provider_auth_key(key, view).await;
        }
        // The `/settings` menu owns the frame the same way (TS
        // `showSelector`).
        if view.settings_menu.is_some() {
            return self.handle_settings_menu_key(key, view).await;
        }
        // The `/share` loader owns the frame while an upload runs (TS the
        // loader takes focus): the cancel binding aborts, other keys are
        // the loader's.
        if view.share_loader.is_some() {
            return self.handle_share_loader_key(key, view).await;
        }
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        // The dispatch order below mirrors the TS key pipeline: the
        // transcript viewport keys (`tui.ts` consumes them before the
        // focused component in fullscreen), then the focused subagent
        // summary line (`SubagentSummaryLine.handleInput` owns every key
        // while focused), then `CustomEditor.handleInput` — paste image,
        // `app.input.clear`, `app.exit` (only when the editor is empty;
        // otherwise ctrl+d falls through to the editor's
        // delete-char-forward), then the app actions in registration
        // order (`app.clear` first, `app.tools.expand` next). Every match
        // goes through the effective bindings, so a user
        // `keybindings.json` override moves both the handler and the hint.
        // Transcript viewport keys (TS tui.ts consumes them before the
        // editor in fullscreen): page scroll, top, follow.
        let (page_up, page_down, to_top, follow) = {
            let kb = view.editor.keybindings();
            (
                kb.matches(&id, "tui.viewport.pageUp"),
                kb.matches(&id, "tui.viewport.pageDown"),
                kb.matches(&id, "tui.viewport.top"),
                kb.matches(&id, "tui.viewport.follow"),
            )
        };
        if page_up {
            view.scroll_by(-(view.page_size() as isize));
            self.track_scroll("page_up", view.is_following());
            self.dirty = true;
            return Ok(());
        }
        if page_down {
            view.scroll_by(view.page_size() as isize);
            self.track_scroll("page_down", view.is_following());
            self.dirty = true;
            return Ok(());
        }
        if to_top {
            view.scroll_to_top();
            self.track_scroll("top", view.is_following());
            self.dirty = true;
            return Ok(());
        }
        if follow {
            view.scroll_to_bottom();
            self.track_scroll("follow", view.is_following());
            self.dirty = true;
            return Ok(());
        }
        // The subagent summary line owns focus while focused (TS
        // `SubagentSummaryLine.handleInput`): confirm/open opens the
        // scoped agents view, up/cancel/back returns to the editor,
        // expand cycles the conversation detail and KEEPS the focus, and
        // every other key falls through after releasing the focus (TS
        // `onChatAction` -> `focusEditor` -> the editor handles it).
        if self.subagents_focused {
            let kb = view.editor.keybindings();
            if kb.matches(&id, "tui.select.confirm") || kb.matches(&id, "app.agents.open") {
                self.open_scoped_agents_view(view);
                return Ok(());
            }
            if kb.matches(&id, "tui.select.up")
                || kb.matches(&id, "tui.select.cancel")
                || kb.matches(&id, "app.agents.back")
            {
                self.subagents_focused = false;
                self.update_subagent_summary(view);
                self.dirty = true;
                return Ok(());
            }
            if kb.matches(&id, "app.tools.expand") {
                view.detail = view.detail.next();
                self.dirty = true;
                return Ok(());
            }
            self.subagents_focused = false;
            self.update_subagent_summary(view);
        }
        // Image paste (TS `app.clipboard.pasteImage`, default ctrl+v):
        // reads the clipboard image and inserts its marker into the
        // editor. The editor's own ctrl+v is unbound otherwise, so the
        // match is exact before any editor motion.
        if view
            .editor
            .keybindings()
            .matches(&id, "app.clipboard.pasteImage")
        {
            self.handle_clipboard_image_paste(view).await;
            return Ok(());
        }
        // The heartbeats-open action (default ctrl+r, TS the editor's
        // `app.heartbeats.open` registration): open the `/heartbeats`
        // management view from anywhere in the session.
        if view
            .editor
            .keybindings()
            .matches(&id, "app.heartbeats.open")
        {
            self.open_heartbeats_view(view).await;
            return Ok(());
        }
        if view.editor.keybindings().matches(&id, "app.input.clear") {
            view.editor.cancel_autocomplete();
            self.clear_ctrl_c_hint();
            // TS `handleEscape`: an open side-question pane owns the key —
            // the running turn aborts and the pane closes; the armed
            // escape-repeat from an earlier press disarms first (TS
            // `clearEscapeRepeat`).
            if view.side_pane.is_some() {
                self.escape_repeat_action = None;
                self.escape_repeat_until = None;
                self.clear_side_question(true, view).await;
                return Ok(());
            }
            // Leaving browse mode restores the stashed draft instead of
            // arming an accidental empty-submit delete of the selected
            // queued message (TS `clearInputBar`).
            if self.queue_selection.has_draft() {
                let draft = self.queue_selection.reset();
                view.editor.set_text(&draft);
                self.sync_queue_selection(view);
                self.dirty = true;
                return Ok(());
            }
            // Double-Escape (TS `handleEscape`'s repeat window): the second
            // press within 500ms opens the tree when the session is idle or
            // the editor empty, and clears the input otherwise.
            if let Some(action) = self.take_escape_repeat_action() {
                if action == "tree" {
                    self.open_tree_selector(view, None).await?;
                } else {
                    view.editor.set_text("");
                }
                self.dirty = true;
                return Ok(());
            }
            let action = if self.turn_active || view.editor.get_text().trim().is_empty() {
                "tree"
            } else {
                "clear"
            };
            self.arm_escape_repeat(action);
            return Ok(());
        }
        if view.editor.keybindings().matches(&id, "app.exit") && view.editor.get_text().is_empty() {
            self.exit_reason = "ctrl_d";
            *running = false;
            return Ok(());
        }
        if view.editor.keybindings().matches(&id, "app.clear") {
            // One handled Ctrl+C press: the force-quit guard disarms once
            // every observed press of the pair was handled without an exit
            // (abort / autocomplete cancel, TS `handleCtrlC`); an exit keeps
            // the deadline and re-arms it on the loop break.
            if id == "ctrl+c" {
                self.exit_guard.note_ctrl_c_handled();
            }
            if view.editor.is_showing_autocomplete() {
                view.editor.cancel_autocomplete();
                self.clear_ctrl_c_hint();
                return Ok(());
            }
            // TS `handleCtrlC`: the first press interrupts (aborting an
            // active turn, showing the exit hint); a second press inside
            // the hint window shuts down unconditionally — no turn wait,
            // no abort wait — so the client always exits promptly.
            if self.ctrl_c_hint_visible() {
                self.exit_reason = "ctrl_c_twice";
                *running = false;
                return Ok(());
            }
            // TS `interruptOrClearInput`: a running side question is
            // aborted first (its failure reported through the note
            // channel, unlike the silent pane-close abort); the pane stays
            // mounted and renders the cancelled turn when the run's
            // terminal event streams back.
            if let Some(side_question_id) = self.active_side_question_id.clone() {
                let client = self.client.clone();
                let active_session_id = self.active_session_id.clone();
                let notes = self.notes.clone();
                tokio::spawn(async move {
                    if let Err(error) = client
                        .request_ok(DaemonCommand::AbortSideQuestion {
                            id: None,
                            active_session_id,
                            side_question_id,
                            rest: Default::default(),
                        })
                        .await
                    {
                        let _ = notes.send(format!("the side question abort failed: {error:#}"));
                    }
                });
            }
            if view.compaction.is_some() {
                // The compaction loader is up (TS `isAgentCompacting()`):
                // the interrupt cancels the compaction run only — the agent
                // is not streaming, so no turn abort goes out, exactly like
                // the TS interrupt key.
                self.abort_compaction();
            } else if self.turn_active {
                self.abort_turn();
                self.note("aborting the current turn", view);
            }
            // A running user-bash command aborts the same way (TS
            // `interruptOrClearInput` fires `void abortBash()`): the
            // settled run reports cancelled through its bash_end.
            if self.user_bash_running {
                self.abort_user_bash();
            }
            self.show_ctrl_c_hint();
            self.dirty = true;
            return Ok(());
        }
        // TS `app.shortcuts` (default `?`, empty editor only — the action
        // loop's `getText().length === 0` gate): mount the quick-shortcut
        // guide above the dock until the next submission.
        if view.editor.keybindings().matches(&id, "app.shortcuts")
            && view.editor.get_text().is_empty()
        {
            view.shortcut_guide = Some(crate::hotkeys::shortcut_guide(view.editor.keybindings()));
            self.dirty = true;
            return Ok(());
        }
        // TS `app.suspend` (default ctrl+z, `handleCtrlZ`): hand the
        // terminal to the shell and stop the process group; the loop
        // performs the cycle right after dispatch, and the SIGCONT
        // continuation re-applies raw mode, the alt screen, and SGR
        // mouse tracking (TS `ui.start()` + `applyFullscreen(true)`).
        // Platforms without a stoppable process group show the TS win32
        // status instead of suspending.
        if view.editor.keybindings().matches(&id, "app.suspend") {
            if crate::suspend::supported() {
                self.suspend_requested = true;
            } else {
                self.note("Suspend to background is not supported on Windows", view);
            }
            return Ok(());
        }
        if view.editor.keybindings().matches(&id, "app.tools.expand") {
            // TS `app.tools.expand` (default ctrl+o) cycles conversation
            // detail: overview -> details -> all -> overview.
            view.detail = view.detail.next();
            // TS `applyChatExpansion` also re-flags the side-question pane
            // (the pane has no bash rows here, so the flag is the only
            // carried state).
            if let Some(pane) = view.side_pane.as_mut() {
                pane.expanded = view.detail == crate::chat::Detail::All;
            }
            self.dirty = true;
            return Ok(());
        }
        // TS `app.subagents.focus` (default alt+a): the summary line takes
        // focus when it is selectable.
        if view
            .editor
            .keybindings()
            .matches(&id, "app.subagents.focus")
        {
            self.focus_subagents_summary(view);
            self.dirty = true;
            return Ok(());
        }
        // TS `app.session.resume` (no default key; user-bindable): open the
        // agents view. Unlike agents-back it fires with a draft in the
        // editor — the draft is stashed for the session on the exit path
        // and returns when the session's chat reopens.
        if view.editor.keybindings().matches(&id, "app.session.resume") {
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
            return Ok(());
        }
        // Agents-back (TS `custom-editor.ts` onAgentsBack): with an empty
        // editor the bound key (default left) hands the terminal to the
        // agents view instead of moving the cursor; with text in the editor
        // the key stays an editor cursor motion. A `--no-session` run has
        // no daemon fleet to browse, so the key stays consumed but only
        // reports that (TS `requestAgentsView` status).
        if view.editor.keybindings().matches(&id, "app.agents.back")
            && view.editor.get_text().trim().is_empty()
        {
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
            return Ok(());
        }
        // `app.session.tree` / `app.session.fork` (TS editor actions): the
        // bound keys open the surfaces when the editor is empty.
        if view.editor.get_text().trim().is_empty() {
            let kb = view.editor.keybindings();
            if kb.matches(&id, "app.session.tree") {
                self.open_tree_selector(view, None).await?;
                self.dirty = true;
                return Ok(());
            }
            if kb.matches(&id, "app.session.fork") {
                self.open_fork_selector(view).await?;
                self.dirty = true;
                return Ok(());
            }
        }
        // The queue browse keys (TS `app.message.navigateOlder/Newer`,
        // defaults alt+up/alt+down) walk the parked messages newest-first,
        // stashing the editor draft; while a message is selected, the
        // reorder keys (TS `app.message.moveEarlier/Later`) move it.
        {
            let (older, newer, earlier, later) = {
                let kb = view.editor.keybindings();
                (
                    kb.matches(&id, "app.message.navigateOlder"),
                    kb.matches(&id, "app.message.navigateNewer"),
                    kb.matches(&id, "app.message.moveEarlier"),
                    kb.matches(&id, "app.message.moveLater"),
                )
            };
            if older {
                self.browse_queue_selection(QueueBrowseDirection::Older, view);
                self.dirty = true;
                return Ok(());
            }
            if newer {
                self.browse_queue_selection(QueueBrowseDirection::Newer, view);
                self.dirty = true;
                return Ok(());
            }
            if earlier {
                self.move_queue_selection(-1, view).await?;
                return Ok(());
            }
            if later {
                self.move_queue_selection(1, view).await?;
                return Ok(());
            }
        }
        // The follow-up key (TS `app.message.followUp`, default alt+enter):
        // the same submit path as Enter, but the message parks on the
        // follow-up lane and delivers when the run goes idle. While a
        // queued message is selected, the edit re-parks it there instead
        // (TS `handleFollowUp`'s browsing branch).
        if view
            .editor
            .keybindings()
            .matches(&id, "app.message.followUp")
        {
            view.editor.submit();
            for event in view.editor.take_events() {
                if let crate::editor::EditorEvent::Submitted(text) = event {
                    if self.queue_selection.is_browsing() {
                        self.apply_queue_selection(&text, QueueLane::FollowUp, view)
                            .await?;
                    } else {
                        view.editor.add_to_history(&text);
                        self.send_prompt(&text, SubmitBehavior::FollowUp, view)
                            .await?;
                    }
                }
            }
            self.dirty = true;
            return Ok(());
        }
        // TS `CustomEditor.handleInput`'s move-below-prompt hook
        // (`onMoveBelowPrompt` -> `focusSubagentSummary`): Down at the end
        // of the prompt — no autocomplete open, no history browse, the
        // cursor at the last line's end — hands the focus to the subagent
        // summary line when it is selectable; every other Down falls
        // through to the editor's cursor motion (a non-selectable line
        // never takes it).
        if view
            .editor
            .keybindings()
            .matches(&id, "tui.editor.cursorDown")
            && !view.editor.is_showing_autocomplete()
            && !view.editor.is_history_navigation_active()
            && view.editor.is_cursor_at_end()
            && self.focus_subagents_summary(view)
        {
            self.dirty = true;
            return Ok(());
        }
        view.editor.handle_input(&id);
        // TS clears the exit hint as soon as the editor carries text: the
        // `Press Ctrl+C again to exit` row belongs to the empty prompt.
        if !view.editor.get_text().is_empty() {
            self.clear_ctrl_c_hint();
        }
        for event in view.editor.take_events() {
            if let crate::editor::EditorEvent::Submitted(text) = event {
                if self.queue_selection.is_browsing() {
                    // Enter steers the selected parked message: the edit
                    // replaces it and moves it onto the steering lane
                    // (TS `applyQueueSelection(text, "steering")`).
                    self.apply_queue_selection(&text, QueueLane::Steering, view)
                        .await?;
                } else {
                    view.editor.add_to_history(&text);
                    self.submit_prompt(&text, view).await?;
                }
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// Project the browse selection to the view: the dim header row above
    /// the editor (TS `getQueueSelectionHeader` reads the live selection).
    fn sync_queue_selection(&mut self, view: &mut AgentView) {
        view.queue_selected = self.queue_selection.selected().cloned();
    }

    /// TS `browseQueueSelection`: move the selection one parked message
    /// older/newer and show it in the editor. Entering the browse stashes
    /// the editor draft; reaching the draft again restores it.
    fn browse_queue_selection(&mut self, direction: QueueBrowseDirection, view: &mut AgentView) {
        let text = self
            .queue_selection
            .browse(&view.queued, &view.editor.get_text(), direction);
        if let Some(text) = text {
            view.editor.set_text(&text);
        }
        self.sync_queue_selection(view);
    }

    /// Send one `mutate_queued_message` and return its status string (TS
    /// answers every outcome `success` with `{ status }`; only a malformed
    /// request fails the command, which surfaces as the error here).
    async fn queue_mutation(
        &self,
        lane: QueueLane,
        index: usize,
        expected_text: &str,
        mutation: Value,
    ) -> Result<Option<String>> {
        let data = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::MutateQueuedMessage {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    lane: Value::String(lane.wire_name().to_string()),
                    index: index as u64,
                    expected_text: expected_text.to_string(),
                    mutation,
                    rest: Default::default(),
                },
            )
            .await
            .map_err(|error| anyhow!("{error:#}"))?;
        Ok(data
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    /// TS `moveQueueSelection`: reorder the selected message one slot
    /// earlier/later in its lane. The move is mirrored locally - the
    /// `session_action_update` event may land after the response, and the
    /// strip and selection must not wait for it (TS mirrors for the same
    /// reason).
    async fn move_queue_selection(&mut self, direction: i64, view: &mut AgentView) -> Result<()> {
        let Some(selected) = self.queue_selection.selected().cloned() else {
            return Ok(());
        };
        let status = self
            .queue_mutation(
                selected.lane,
                selected.index,
                &selected.text,
                serde_json::json!({ "type": "move", "direction": direction }),
            )
            .await;
        match status {
            Ok(Some(status)) if status == "applied" => {
                let target = selected.index as i64 + direction;
                crate::queued::mirror_lane_move(
                    &mut view.queued,
                    selected.lane,
                    selected.index,
                    target,
                );
                if target >= 0 {
                    self.queue_selection.refresh_at(
                        &view.queued,
                        selected.lane,
                        target as usize,
                        &selected.text,
                    );
                }
                self.sync_queue_selection(view);
                self.dirty = true;
            }
            Ok(Some(status)) => self.note(&queue_mutation_status_note(&status, false), view),
            // A malformed request (never sent by this build) surfaces the
            // daemon error like every other command.
            Ok(None) => {}
            Err(error) => self.note(&format!("{error:#}"), view),
        }
        Ok(())
    }

    /// TS `applyQueueSelection`: apply the edited editor text to the
    /// selected parked message. Empty text deletes it; otherwise the edit
    /// replaces it and moves it to `target_lane` - Enter steers, the
    /// follow-up key parks it for idle delivery.
    async fn apply_queue_selection(
        &mut self,
        text: &str,
        target_lane: QueueLane,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(selected) = self.queue_selection.selected().cloned() else {
            return Ok(());
        };
        let trimmed = text.trim();
        // `images` stays absent on a replace: the server keeps the item's
        // attachments (some markers cannot be resolved by this client).
        let mutation = if trimmed.is_empty() {
            serde_json::json!({ "type": "delete" })
        } else {
            serde_json::json!({ "type": "replace", "text": trimmed, "lane": target_lane.wire_name() })
        };
        let status = self
            .queue_mutation(selected.lane, selected.index, &selected.text, mutation)
            .await;
        match status {
            Ok(Some(status)) if status == "applied" => {
                if !trimmed.is_empty() {
                    view.editor.add_to_history(trimmed);
                }
                let draft = self.queue_selection.reset();
                view.editor.set_text(&draft);
            }
            Ok(Some(status)) => {
                // Enter submissions clear the editor before the mutation;
                // a failed edit returns to the editor, never swallowed.
                view.editor.set_text(text);
                self.note(&queue_mutation_status_note(&status, true), view);
            }
            Ok(None) => {}
            Err(error) => {
                view.editor.set_text(text);
                self.note(&format!("{error:#}"), view);
            }
        }
        self.sync_queue_selection(view);
        self.dirty = true;
        Ok(())
    }

    pub(crate) fn apply_client_event(&mut self, event: DaemonClientEvent, view: &mut AgentView) {
        match event {
            DaemonClientEvent::SessionEvent {
                active_session_id,
                event,
            } => {
                if active_session_id != self.active_session_id {
                    return;
                }
                if let Some(update) = event_to_update(&event) {
                    self.apply_update(update, view);
                }
            }
            DaemonClientEvent::SideQuestionEvent {
                active_session_id,
                event,
            } => {
                if active_session_id == self.active_session_id {
                    self.apply_side_question_event(&event, view);
                }
            }
            DaemonClientEvent::SessionClosed {
                active_session_id,
                reason,
            } => {
                if active_session_id == self.active_session_id {
                    self.turn_active = false;
                    view.working = None;
                    self.note(&format!("session closed ({reason})"), view);
                }
            }
            DaemonClientEvent::DirectLinkLost { active_session_id } => {
                // TS `handleTransportClose`: a direct-transport loss is
                // never itself a session loss — the interactive loop
                // re-attaches through the supervisor. Only the active
                // session arms the loop; a replaced link (session switch)
                // reports its old session and is ignored here.
                if active_session_id == self.active_session_id {
                    self.transport_lost = Some(active_session_id);
                }
            }
            DaemonClientEvent::DaemonClosing { reason, update } => {
                match update {
                    Some(update) => {
                        // Spec §10: reattach is the default end state. The
                        // banner carries the resume contract; the reconnect
                        // loop in the interactive run drives the rest (UI
                        // stays mounted, retry with backoff up to 10 min,
                        // reattach by durable id once the successor serves).
                        let names = update
                            .sessions
                            .iter()
                            .map(|row| {
                                row.get("name")
                                    .and_then(|value| value.as_str())
                                    .filter(|name| !name.is_empty())
                                    .unwrap_or_else(|| {
                                        row.get("sessionId")
                                            .and_then(|value| value.as_str())
                                            .unwrap_or_default()
                                    })
                            })
                            .collect::<Vec<_>>()
                            .join(", ");
                        view.push_entry(crate::chat::ChatEntry::Status {
                            text: format!(
                                "Prime Agent is updating — restarting the daemon (about {}s). {} will resume automatically.",
                                update.est_seconds.max(1),
                                if names.is_empty() { "Your session".to_string() } else { names }
                            ),
                            kind: crate::chat::StatusKind::Info,
                        });
                        self.reconnect = Some(update);
                    }
                    None => {
                        self.note(&format!("the daemon is shutting down ({reason})"), view);
                    }
                }
            }
            // The roster push keeps the subagent summary counts live (TS
            // `subscribeAgentRoster` -> `updateSubagentSummaryLine`).
            DaemonClientEvent::RosterUpdate {
                changed,
                removed,
                resync,
            } => {
                self.apply_roster_update(changed, removed, resync);
                self.update_subagent_summary(view);
                self.dirty = true;
            }
            // A heartbeat catalog change anywhere in the daemon (TS
            // `broadcastGlobal`): an open `/heartbeats` view refreshes in
            // the background through the update channel (TS
            // `refreshHeartbeatCatalog`).
            DaemonClientEvent::HeartbeatsChanged => {
                if view.heartbeats_picker.is_some() {
                    self.spawn_heartbeat_refresh();
                }
            }
            // Saved-session list frames belong to the agents-view UI; the
            // session view only reads its own session.
            DaemonClientEvent::SessionListItem { .. }
            | DaemonClientEvent::SessionListProgress { .. } => {}
        }
    }

    fn apply_update(&mut self, update: TurnUpdate, view: &mut AgentView) {
        match update {
            TurnUpdate::TurnStarted => {
                self.turn_active = true;
                self.turn_error_shown = false;
                self.start_loader(view);
            }
            TurnUpdate::UserMessage(text) => {
                // TS `addMessageToChat`'s user case: a skill block parses
                // into the skill-invocation card plus the trailing
                // argument text as its own user block.
                match crate::custom_message::skill_invocation_entries(&text) {
                    Some(entries) => {
                        for entry in entries {
                            view.push_entry(entry);
                        }
                    }
                    None => view.push_entry(ChatEntry::User { text }),
                }
            }
            // `session_info_changed`: the display name moved (the `/name`
            // path also sets it locally; this is the other-client arm).
            TurnUpdate::SessionInfoChanged { name } => {
                self.session_name = name;
                view.chrome.chat_name = self.session_display();
                self.dirty = true;
            }
            // `service_tier_changed`: keep the local tier state current (TS
            // patches the connection state; `/fast` reads it).
            TurnUpdate::ServiceTierChanged { tier } => {
                self.service_tier = Some(tier);
                self.dirty = true;
            }
            TurnUpdate::CustomRow(entry) => {
                view.push_entry(entry);
            }
            TurnUpdate::AssistantMessage {
                message,
                streaming,
                stream_event,
            } => {
                self.apply_assistant_message(&message, streaming, stream_event.as_ref(), view);
            }
            TurnUpdate::ToolExecutionStart {
                tool_call_id,
                tool_name,
                args,
            } => {
                crate::snapshot::apply_tool_execution_start(view, &tool_call_id, &tool_name, args);
                self.set_working_activity("Executing", false, view);
            }
            TurnUpdate::ToolExecutionUpdate {
                tool_call_id,
                partial,
            } => {
                // A `starting` partial (python-kernel bootstrap) owns the
                // loader note (TS `setWorkingMessage`); other updates leave
                // any current note alone.
                if let Some(message) = crate::snapshot::working_message_from_update(&partial) {
                    if let Some(working) = &mut view.working {
                        working.message = Some(message);
                    }
                }
                self.apply_tool_result(&tool_call_id, partial, false, true, view);
            }
            TurnUpdate::ToolExecutionEnd {
                tool_call_id,
                result,
                is_error,
            } => {
                self.apply_tool_result(&tool_call_id, result, is_error, false, view);
                self.set_working_activity("Waiting", false, view);
                // The tool that owned the loader note finished executing
                // (TS clears `workingMessage` in the tool's `finally`).
                if let Some(working) = &mut view.working {
                    working.message = None;
                }
            }
            TurnUpdate::TurnEnded { error } => {
                // Only the engine's own turn_end clears the busy state:
                // trailing `agent_end` frames from the previous turn must
                // not cancel a turn admitted in between (prompt queueing).
                self.streaming_index = None;
                self.turn_active = false;
                view.working = None;
                view.working_since = None;
                view.retry = None;
                // A provider failure already surfaced through the failed
                // assistant message and/or the retry-exhausted banner; the
                // turn result error is only a silent-failure backstop.
                if let (Some(error), false) = (error, self.turn_error_shown) {
                    view.push_entry(ChatEntry::Status {
                        text: format!("turn failed: {error}"),
                        kind: StatusKind::Warning,
                    });
                }
            }
            TurnUpdate::AutoRetryStart {
                attempt,
                max_attempts,
                delay_ms,
                error_message,
                reason,
            } => {
                // The retry countdown loader replaces the working loader
                // until the loop settles (TS auto_retry_start). A backup
                // reason is a provider-failover switch: the loader names
                // the backup provider the turn re-routes to (no countdown;
                // the switch re-issues immediately).
                view.retry = Some(RetryState {
                    attempt,
                    max_attempts,
                    ends_at: std::time::Instant::now() + std::time::Duration::from_millis(delay_ms),
                    error_message,
                    reason,
                });
            }
            TurnUpdate::AutoRetryEnd {
                success: _,
                attempt,
                final_error,
                restored_model,
            } => {
                view.retry = None;
                if let Some(final_error) = final_error {
                    self.turn_error_shown = true;
                    view.push_entry(ChatEntry::Status {
                        text: format!(
                            "\u{26a0} Error: Retry failed after {attempt} attempts: {final_error}"
                        ),
                        kind: StatusKind::Error,
                    });
                }
                // A settled switch restores the primary provider (TS
                // `restoredModel` status line).
                if let Some(restored_model) = restored_model {
                    view.push_entry(ChatEntry::Status {
                        text: format!("Primary provider recovered — back on {restored_model}"),
                        kind: StatusKind::Info,
                    });
                }
            }
            TurnUpdate::CompactionStart {
                reason,
                custom_instructions,
            } => {
                // TS `startCompactionLoader`: the compaction loader fully
                // replaces the working loader for the run's duration.
                view.working = None;
                view.compaction = Some(CompactionState {
                    reason: CompactionReason::parse(&reason),
                    custom_instructions,
                });
            }
            TurnUpdate::CompactionEnd {
                reason,
                result,
                custom_instructions,
                aborted,
                error_message,
                error_severity,
            } => {
                view.compaction = None;
                if let Some(result) = result {
                    // A succeeded compaction rebuilt the durable transcript
                    // (it now starts at the compaction summary): show the
                    // outcome row immediately, then re-fetch the transcript
                    // so the compacted-away rows drop (TS
                    // `rebuildChatFromMessages`).
                    view.push_entry(ChatEntry::CompactionSummary {
                        summary: result
                            .get("summary")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        tokens_before: result
                            .get("tokensBefore")
                            .and_then(Value::as_u64)
                            .unwrap_or_default(),
                        custom_instructions,
                    });
                    self.transcript_stale = true;
                } else if reason == "manual" {
                    // TS `compaction_end` handling: aborts and error
                    // messages surface only for user-issued compactions,
                    // through `showError`/`showWarning` (whose rows carry
                    // the `⚠ Error: ` / `⚠ ` prefixes).
                    if aborted {
                        view.push_entry(ChatEntry::Status {
                            text: "\u{26a0} Error: Compaction cancelled".to_string(),
                            kind: StatusKind::Error,
                        });
                    } else if let Some(message) = error_message {
                        if error_severity.as_deref() == Some("warning") {
                            view.push_entry(ChatEntry::Status {
                                text: format!("\u{26a0} {message}"),
                                kind: StatusKind::Warning,
                            });
                        } else {
                            view.push_entry(ChatEntry::Status {
                                text: format!("\u{26a0} Error: {message}"),
                                kind: StatusKind::Error,
                            });
                        }
                    }
                }
            }
            TurnUpdate::Idle => {
                if !self.turn_active {
                    view.working = None;
                }
            }
            TurnUpdate::GoalUpdate(goal) => {
                self.apply_goal_update(goal, view);
            }
            TurnUpdate::BashStart {
                command,
                exclude_from_context: _,
                transient,
                run_id,
            } => {
                self.apply_bash_start(command, transient, run_id, view);
            }
            TurnUpdate::BashOutput { chunk } => {
                self.apply_bash_output(&chunk, view);
            }
            TurnUpdate::BashEnd {
                exit_code,
                cancelled,
                truncated,
                full_output_path,
                error_message,
                transient,
                run_id,
            } => {
                self.apply_bash_end(
                    exit_code,
                    cancelled,
                    truncated,
                    full_output_path,
                    error_message,
                    transient,
                    run_id,
                    view,
                );
            }
            TurnUpdate::QueueUpdated {
                steering,
                follow_ups,
            } => {
                view.queued = crate::queued::QueuedMessages {
                    steering,
                    follow_ups,
                };
                // A queue change under an active browse reconciles the
                // selection (TS `refreshQueueSelectionAt`): the cursor
                // survives only when the addressed item is unchanged; a
                // stale selection drops and its stashed draft returns to
                // the editor.
                if let Some(selected) = self.queue_selection.selected() {
                    let (lane, index, text) =
                        (selected.lane, selected.index, selected.text.clone());
                    if let Some(draft) =
                        self.queue_selection
                            .refresh_at(&view.queued, lane, index, &text)
                    {
                        if view.editor.get_text() == text {
                            view.editor.set_text(&draft);
                        }
                    }
                }
                self.sync_queue_selection(view);
            }
            TurnUpdate::StatusUpdate => {}
        }
        self.dirty = true;
    }

    /// `bash_start` (TS the interactive `bash_start` case): a user-bash run
    /// began. The client's running flag patches first (the slot is
    /// session-scoped), then a discarded side run's events are swallowed
    /// (aborting by its identity so the slot frees), a foreign transient
    /// run renders only in its owning client's pane, an own side run
    /// mounts its row in the pane, and a main-thread run mounts the usual
    /// bash transcript card.
    fn apply_bash_start(
        &mut self,
        command: String,
        transient: bool,
        run_id: Option<String>,
        view: &mut AgentView,
    ) {
        self.user_bash_running = true;
        if let Some(discarded) = self.side_bash_discarded.clone() {
            if run_id.as_deref() == Some(&discarded) {
                // The discarded run now owns the bash slot: abort only
                // after matching its identity, so a foreign run is never
                // killed (TS aborts the same way).
                self.abort_user_bash();
                return;
            }
            // A different run claimed the slot, so the discarded run lost
            // the race and can never start: render this run normally.
            self.side_bash_discarded = None;
        }
        let own_side_bash = self
            .side_bash
            .as_ref()
            .is_some_and(|run| run_id.as_deref() == Some(run.run_id.as_str()));
        if transient && !own_side_bash {
            // Another client's side-conversation run: it renders only in
            // that client's pane, never in this window's chat.
            return;
        }
        if own_side_bash && view.side_pane.is_some() {
            // The same component as the main thread, mounted inside the
            // pane (TS `sideQuestionComponent.addBash`).
            if let Some(pane) = view.side_pane.as_mut() {
                pane.bash = Some(crate::side_question::PaneBash::new_running(&command));
            }
            self.user_bash_card = None;
            self.user_bash_output.clear();
            return;
        }
        // The main-thread card (the same bash transcript item a replayed
        // `bashExecution` row renders).
        self.user_bash_counter += 1;
        let id = format!("user-bash-{}", self.user_bash_counter);
        view.push_entry(ChatEntry::Tool(Box::new(crate::tool_card::ToolCallCard {
            id: id.clone(),
            name: "bash".to_string(),
            args: serde_json::json!({ "command": command }),
            started: true,
            started_at: Some(std::time::Instant::now()),
            ..Default::default()
        })));
        self.user_bash_card = Some(id);
        self.user_bash_output.clear();
    }

    /// `bash_output` (TS the `bash_output` case): one streamed chunk
    /// appends to the active surface — the pane's row for a side run, the
    /// transcript card's partial result otherwise. Discarded runs
    /// swallow their chunks.
    fn apply_bash_output(&mut self, chunk: &str, view: &mut AgentView) {
        if self.side_bash_discarded.is_some() {
            return;
        }
        if let Some(pane) = view.side_pane.as_mut() {
            if let Some(bash) = pane.bash.as_mut() {
                bash.output.push_str(chunk);
                return;
            }
        }
        let Some(card_id) = self.user_bash_card.clone() else {
            return;
        };
        self.user_bash_output.push_str(chunk);
        self.fold_bash_result(&card_id, self.user_bash_output.clone(), false, true, view);
    }

    /// `bash_end` (TS the `bash_end` case): the settled run patches the
    /// running flag, completes the mounted row (or surfaces the failure
    /// when no row is mounted), and an own pane-mounted run seeds the
    /// follow-up side questions (the `!`, not `!!`, variant — unless it
    /// was cancelled or failed).
    #[allow(clippy::too_many_arguments)]
    fn apply_bash_end(
        &mut self,
        exit_code: Option<i64>,
        cancelled: bool,
        truncated: bool,
        full_output_path: Option<String>,
        error_message: Option<String>,
        transient: bool,
        run_id: Option<String>,
        view: &mut AgentView,
    ) {
        self.user_bash_running = false;
        if let Some(discarded) = self.side_bash_discarded.clone() {
            if run_id.as_deref() == Some(&discarded) {
                // Only the discarded run's own end consumes the marker
                // (bash_start already cleared it for any other run that
                // claimed the slot).
                self.side_bash_discarded = None;
                self.user_bash_card = None;
                return;
            }
        }
        // An own side run: settle the pane's row and seed the follow-up
        // transcript (TS `finishSideQuestionBash`).
        if let Some(run) = self.side_bash.take() {
            let own_run = run_id.as_deref() == Some(run.run_id.as_str());
            let pane_mounted = view
                .side_pane
                .as_ref()
                .is_some_and(|pane| pane.bash.is_some());
            if own_run && pane_mounted {
                let pane = view.side_pane.as_mut().expect("checked");
                if let Some(bash) = pane.bash.as_mut() {
                    bash.running = false;
                    bash.exit_code = exit_code;
                    bash.cancelled = cancelled;
                    bash.truncated = truncated;
                    bash.full_output_path = full_output_path.clone();
                    bash.error_message = error_message.clone();
                }
                if run.seed_transcript && !cancelled && error_message.is_none() {
                    let raw = pane
                        .bash
                        .as_ref()
                        .map(|bash| bash.output.clone())
                        .unwrap_or_default();
                    let (tail, tail_truncated) = crate::bash_bang::truncate_tail(&raw);
                    let output = tail.trim_end_matches('\n').to_string();
                    let answer = crate::bash_bang::bash_output_to_text(
                        &output,
                        exit_code,
                        truncated || tail_truncated,
                        full_output_path.as_deref(),
                    );
                    pane.extra_seeds.push((run.input.clone(), answer));
                }
            }
        }
        // The main-thread transcript card settles (an error status when
        // the run failed or exited non-zero, TS `setComplete`/
        // `setFailed`).
        if let Some(card_id) = self.user_bash_card.take() {
            let failed = error_message.is_some() || exit_code.is_some_and(|code| code != 0);
            self.fold_bash_result(&card_id, self.user_bash_output.clone(), failed, false, view);
            let card_index = view
                .chat
                .iter()
                .position(|entry| matches!(entry, ChatEntry::Tool(card) if card.id == card_id));
            if let Some(index) = card_index {
                view.prepare_entry_mutation();
                if let Some(ChatEntry::Tool(card)) = view.chat.get_mut(index) {
                    card.ended_at = Some(std::time::Instant::now());
                    card.result_partial = false;
                    let mut details = serde_json::json!({
                        "cancelled": cancelled,
                        "truncated": truncated,
                    });
                    if let Some(code) = exit_code {
                        details["exitCode"] = serde_json::json!(code);
                    }
                    if let Some(path) = &full_output_path {
                        details["fullOutputPath"] = serde_json::json!(path);
                    }
                    if let Some(message) = &error_message {
                        details["errorMessage"] = serde_json::json!(message);
                    }
                    if truncated {
                        details["truncation"] = serde_json::json!({ "truncated": true });
                    }
                    if let Some(result) = card.result.as_mut() {
                        result.details = details;
                    }
                    view.mark_entry_stale(index);
                }
            }
        } else if let Some(message) = error_message {
            // Transient failures surface in the owning client's pane,
            // not here (TS `showError`: the `⚠ Error:` row).
            if !transient {
                self.error_row(&format!("Bash command failed: {message}"), view);
            }
        }
    }

    /// Fold the user-bash output onto the mounted transcript card: the
    /// accumulated text as a (partial or final) result frame.
    fn fold_bash_result(
        &self,
        card_id: &str,
        output: String,
        is_error: bool,
        partial: bool,
        view: &mut AgentView,
    ) {
        let result = ToolResultView {
            content: vec![serde_json::json!({ "type": "text", "text": output })],
            details: serde_json::Value::Null,
            is_error,
        };
        let card_index = view
            .chat
            .iter()
            .position(|entry| matches!(entry, ChatEntry::Tool(card) if card.id == card_id));
        if let Some(index) = card_index {
            view.prepare_entry_mutation();
            if let Some(ChatEntry::Tool(card)) = view.chat.get_mut(index) {
                card.result = Some(result);
                card.result_partial = partial;
                view.mark_entry_stale(index);
            }
        }
    }

    /// `abort_bash` off the UI loop (TS `interruptOrClearInput` fires
    /// `void abortBash()`): the request never blocks key handling, and a
    /// failure surfaces as a background note.
    fn abort_user_bash(&self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let notes = self.notes.clone();
        tokio::spawn(async move {
            if let Err(error) = client
                .request_ok(DaemonCommand::AbortBash {
                    id: None,
                    active_session_id,
                    rest: Default::default(),
                })
                .await
            {
                let _ = notes.send(format!("the bash abort failed: {error:#}"));
            }
        });
    }

    /// Apply an assistant message frame: an open streaming message is
    /// updated in place; otherwise the message expands into a chat component
    /// plus a card per tool call.
    fn apply_assistant_message(
        &mut self,
        message: &Value,
        streaming: bool,
        stream_event: Option<&Value>,
        view: &mut AgentView,
    ) {
        if let Some(event) = stream_event {
            self.track_stream_activity(event, view);
        }
        let (blocks, tool_calls) = assistant_message_parts(message);
        // A message_start always opens a new streaming message (the engine
        // emits one per provider call); later frames update it in place.
        let starts_message = stream_event
            .and_then(|event| event.get("type"))
            .and_then(Value::as_str)
            == Some("start");
        let usage_output = message
            .get("usage")
            .and_then(|usage| usage.get("output"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if streaming {
            if starts_message {
                self.working_tokens.start_message();
            }
            let content_chars: u64 = blocks
                .iter()
                .map(|block| match block {
                    MessageBlock::Text(text) | MessageBlock::Thinking(text) => {
                        text.chars().count() as u64
                    }
                })
                .sum();
            let current = self
                .working_tokens
                .apply_streaming(usage_output, content_chars);
            if let Some(working) = &mut view.working {
                working.tokens = working.tokens.max(current);
            }
        } else {
            self.working_tokens.settle(usage_output);
        }
        if let Some(text) = blocks.iter().rev().find_map(|block| match block {
            MessageBlock::Text(text) => Some(text.clone()),
            _ => None,
        }) {
            self.last_assistant_text = Some(text);
        }
        let has_tool_calls = !tool_calls.is_empty();
        // A message_start always opens a new streaming message (the engine
        // emits one per provider call); later frames update it in place.
        if starts_message {
            self.streaming_index = None;
        }
        match self.streaming_index {
            Some(index) => {
                view.prepare_entry_mutation();
                if let Some(ChatEntry::Assistant(open)) = view.chat.get_mut(index) {
                    open.blocks = blocks;
                    open.has_tool_calls = has_tool_calls;
                    open.streaming = streaming;
                }
                view.mark_entry_stale(index);
            }
            None => {
                if !blocks.is_empty() {
                    view.push_entry(ChatEntry::Assistant(Box::new(
                        crate::chat::AssistantMessage {
                            blocks,
                            has_tool_calls,
                            streaming,
                            error: None,
                            aborted: false,
                        },
                    )));
                    self.streaming_index = Some(view.chat.len() - 1);
                }
            }
        }
        for (id, name, args) in &tool_calls {
            // A streamed tool call first appears queued; the execution start
            // event flips it to running, and later frames refresh its name
            // and args while they stream (TS `updateArgs` + the latest
            // streaming call winning at component creation).
            crate::snapshot::apply_streamed_tool_card(view, id, name, args);
        }
        if !streaming {
            let open = self.streaming_index.take();
            self.finalize_assistant_error(message, &tool_calls, open, view);
        }
    }

    /// The final frame of a failed assistant message renders its error row
    /// (TS renders it inside the assistant component): `aborted` always
    /// shows, `error` only when the message carries no tool calls (the
    /// pending cards carry the failure then). The row renders inside the
    /// message's own component — the open streaming entry when one exists,
    /// otherwise a fresh entry: TS creates one component per assistant
    /// message (`message_start`), so a content-less provider failure stacks
    /// its own error row per failed attempt instead of decorating the
    /// previous reply (TS `AssistantMessageComponent.rebuild`).
    fn finalize_assistant_error(
        &mut self,
        message: &Value,
        tool_calls: &[(String, String, Value)],
        open: Option<usize>,
        view: &mut AgentView,
    ) {
        let Some(error) = crate::snapshot::assistant_error_row(message, tool_calls) else {
            return;
        };
        self.turn_error_shown = true;
        if let Some(index) = open {
            view.prepare_entry_mutation();
            if let Some(ChatEntry::Assistant(entry)) = view.chat.get_mut(index) {
                entry.error = Some(error.text);
                entry.aborted = error.aborted;
                view.mark_entry_stale(index);
                return;
            }
        }
        // The message rendered no component (empty content): TS still
        // renders the message's own error component, so the failure stacks
        // as a separate row instead of attaching to the last assistant.
        view.push_entry(ChatEntry::Assistant(Box::new(
            crate::chat::AssistantMessage {
                blocks: Vec::new(),
                has_tool_calls: false,
                streaming: false,
                error: Some(error.text),
                aborted: error.aborted,
            },
        )));
    }

    /// Attach a (partial or final) tool result to the matching card.
    fn apply_tool_result(
        &mut self,
        tool_call_id: &str,
        result: Value,
        is_error: bool,
        partial: bool,
        view: &mut AgentView,
    ) {
        let result = ToolResultView {
            content: result
                .get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            details: result.get("details").cloned().unwrap_or(Value::Null),
            is_error,
        };
        let card_index = view
            .chat
            .iter()
            .position(|entry| matches!(entry, ChatEntry::Tool(card) if card.id == tool_call_id));
        if let Some(index) = card_index {
            view.prepare_entry_mutation();
            if let Some(ChatEntry::Tool(card)) = view.chat.get_mut(index) {
                card.result = Some(result);
                card.result_partial = partial;
                if !partial {
                    card.ended_at = Some(std::time::Instant::now());
                }
                view.mark_entry_stale(index);
            }
        }
    }

    /// Update the loader activity label (agent-activity tracker subset).
    fn set_working_activity(
        &mut self,
        activity: &'static str,
        download: bool,
        view: &mut AgentView,
    ) {
        if let Some(working) = &mut view.working {
            working.activity = activity;
            working.download = download;
        }
    }
}

/// Deterministic list order: most recently active first (missing activity
/// timestamps last), so `/switch <n>` targets are stable between `/list`
/// renders.
/// The terminal's current column count (TS `this.ui.terminal.columns` for
/// the goal status detail suffix); 80 when the size is unavailable.
fn terminal_columns() -> usize {
    crossterm::terminal::size()
        .map(|(columns, _)| columns as usize)
        .unwrap_or(80)
}

fn sorted_session_rows(mut sessions: Vec<Value>) -> Vec<Value> {
    let activity_of = |row: &Value| -> String {
        row.get("lastActivityAt")
            .or_else(|| row.get("modified"))
            .or_else(|| row.get("created"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    sessions.sort_by(|left, right| {
        let (left, right) = (activity_of(left), activity_of(right));
        if left.is_empty() && right.is_empty() {
            return std::cmp::Ordering::Equal;
        }
        if left.is_empty() {
            return std::cmp::Ordering::Greater;
        }
        if right.is_empty() {
            return std::cmp::Ordering::Less;
        }
        right.cmp(&left)
    });
    sessions
}

/// TS `isBashRunning` guard's warning: the clear key (app.clear) cancels
/// the running user command, spelled through the effective keybindings.
fn already_running_warning(keybindings: &crate::keybindings::KeybindingsManager) -> String {
    let key = keybindings
        .first_key("app.clear")
        .map(|key| crate::keybindings::format_key_text(&key))
        .unwrap_or_else(|| "Ctrl+C".to_string());
    // TS `showWarning` renders `⚠ ${message}`: the prefix travels with the
    // row text (the StatusKind tier is color only).
    format!("\u{26a0} A bash command is already running. Press {key} to cancel it first.")
}

/// TS `formatResumeHint` (resume-hint.ts): the post-exit hint names how to
/// resume the session just left. Ephemeral (no session file) and unflushed
/// empty sessions are omitted — neither can be resumed. Persistence is
/// lazy: a file that does not exist on disk cannot be resumed either.
pub(crate) fn resume_hint_from_stats(stats: &Value) -> Option<String> {
    let session_id = stats.get("sessionId").and_then(Value::as_str)?;
    let session_file = stats.get("sessionFile").and_then(Value::as_str)?;
    let user_messages = stats
        .get("userMessages")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    if session_file.is_empty() || user_messages == 0 || !std::path::Path::new(session_file).exists()
    {
        return None;
    }
    Some(format!(
        "Resume this session with: prime-agent --resume {session_id}"
    ))
}

/// Send a `create` command and return the new session's active id. A
/// non-empty selection picks the reopen form: `continueRecent` or an
/// explicit saved-session path.
/// The picker's viewport row budget (TS `showConfigurationMenu` passes
/// `min(20, rows - 3)` and `ConfigurationMenuComponent` subtracts one more
/// row for its hint).
/// TS `getTrayHeartbeatLabel`: `N heartbeats[ · M paused] (Ctrl+R)` over
/// the scoped catalog; `None` when no heartbeat is in scope.
fn tray_heartbeat_label(
    heartbeats: &[HeartbeatEntry],
    kb: &crate::keybindings::KeybindingsManager,
) -> Option<String> {
    if heartbeats.is_empty() {
        return None;
    }
    let paused = heartbeats
        .iter()
        .filter(|entry| entry.job.status == "paused")
        .count();
    let plural = if heartbeats.len() == 1 { "" } else { "s" };
    let mut label = format!("{} heartbeat{plural}", heartbeats.len());
    if paused > 0 {
        label.push_str(&format!(" \u{b7} {paused} paused"));
    }
    if let Some(key) = kb.first_key("app.heartbeats.open") {
        let key = crate::keybindings::format_key_text(&key);
        label.push_str(&format!(" ({key})"));
    }
    Some(label)
}

fn picker_viewport_rows(terminal_rows: u16) -> usize {
    let terminal_rows = terminal_rows as usize;
    let menu_rows = 20.min(terminal_rows.saturating_sub(3).max(1));
    menu_rows.saturating_sub(1).max(1)
}

async fn create_session(
    client: &DaemonClient,
    options: &InteractiveOptions,
    selection: Option<&SessionSelection>,
) -> Result<String> {
    let continue_recent = matches!(selection, Some(SessionSelection::ContinueRecent));
    let session_path = match selection {
        Some(SessionSelection::Resume(path)) => Some(path.to_string_lossy().to_string()),
        _ => None,
    };
    let data = client
        .request_ok(DaemonCommand::Create {
            id: None,
            session_path,
            continue_recent: continue_recent.then_some(true),
            no_session: options.no_session.then_some(true),
            name: None,
            config: Some(options.create_config()),
            telemetry_disabled: options.telemetry_disabled.filter(|disabled| *disabled),
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: Default::default(),
        })
        .await?;
    data.get("activeSessionId")
        .or_else(|| data.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("the daemon did not report a session id for the new session"))
}

#[cfg(test)]
mod bash_bang_tests {
    use super::already_running_warning;
    use crate::keybindings::KeybindingsManager;

    /// TS `isBashRunning` guard: the warning spells the clear key
    /// through the effective bindings (the default is ctrl+c).
    #[test]
    fn the_running_guard_names_the_clear_key() {
        let warning = already_running_warning(&KeybindingsManager::new());
        assert!(
            warning.starts_with("\u{26a0} A bash command is already running. Press ")
                && warning.ends_with(" to cancel it first."),
            "the guard sentence matches TS: {warning}"
        );
        assert!(warning.contains("Ctrl+C"));
    }
}

#[cfg(test)]
mod tray_heartbeat_label_tests {
    use super::{tray_heartbeat_label, HeartbeatEntry};
    use crate::heartbeats_picker::parse_heartbeat_job;
    use crate::keybindings::KeybindingsManager;

    fn entry(job_json: serde_json::Value) -> HeartbeatEntry {
        HeartbeatEntry {
            job: parse_heartbeat_job(&job_json).expect("job parses"),
            session_name: None,
            first_message: None,
        }
    }

    fn job(id: &str, status: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "status": status,
            "source": "heartbeat",
            "activeSessionId": "live-1",
            "sessionId": "sess-1",
            "schedule": {"kind": "interval", "expression": "every 30m"},
        })
    }

    /// TS `getTrayHeartbeatLabel`: no heartbeat in scope renders no label,
    /// counts carry the plural and the paused suffix, and the open-shortcut
    /// hint trails the default binding.
    #[test]
    fn label_counts_heartbeats_and_the_paused_suffix() {
        let kb = KeybindingsManager::new();
        assert_eq!(tray_heartbeat_label(&[], &kb), None);
        let active = entry(job("a", "active"));
        assert_eq!(
            tray_heartbeat_label(std::slice::from_ref(&active), &kb).as_deref(),
            Some("1 heartbeat (Ctrl+R)")
        );
        let paused = entry(job("b", "paused"));
        assert_eq!(
            tray_heartbeat_label(&[active, paused], &kb).as_deref(),
            Some("2 heartbeats · 1 paused (Ctrl+R)")
        );
    }
}

#[cfg(test)]
mod loader_token_tests {
    use super::LoaderTokenTracker;

    /// The live count derives from the streamed message, so coalesced
    /// frames (one latest-snapshot wire frame per flush tick) count the
    /// full streamed size — a per-delta sum would undercount them ~20x.
    #[test]
    fn coalesced_frames_count_from_the_message_not_deltas() {
        let mut tracker = LoaderTokenTracker::default();
        tracker.reset();
        // A message streams to 400 chars; the coalesced wire frame carries
        // the full snapshot but only the final provider delta.
        assert_eq!(tracker.apply_streaming(0, 400), 100);
        // A provider that reports usage upfront wins over the estimate.
        assert_eq!(tracker.apply_streaming(600, 400), 600);
        // Settle banks the reported usage, then the live state is empty.
        tracker.settle(600);
        assert_eq!(tracker.current(), 600);
    }

    /// Settling without reported usage banks the live estimate (TS
    /// `usage.output > 0 ? usage.output : estimatedStreamingTokens()`).
    #[test]
    fn settle_without_usage_banks_the_estimate() {
        let mut tracker = LoaderTokenTracker::default();
        tracker.reset();
        assert_eq!(tracker.apply_streaming(0, 404), 101);
        tracker.settle(0);
        assert_eq!(tracker.current(), 101);
    }

    /// A new message resets the live state but keeps the run's completed
    /// count; `agent_start` resets the whole tracker (TS `reset`).
    #[test]
    fn message_start_resets_the_live_state_and_agent_start_the_run() {
        let mut tracker = LoaderTokenTracker::default();
        tracker.reset();
        assert_eq!(tracker.apply_streaming(0, 800), 200);
        tracker.settle(0);
        tracker.start_message();
        // The live count rides on the run's completed count: 200 banked
        // plus the new message's reported 50.
        assert_eq!(tracker.apply_streaming(50, 8), 250);
        tracker.settle(50);
        assert_eq!(tracker.current(), 250);
        tracker.reset();
        assert_eq!(tracker.current(), 0);
    }
}
