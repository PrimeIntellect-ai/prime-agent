//! Live per-session UI state for the interactive loop: the daemon-client
//! side of one attached session — prompt submission, slash commands, streamed
//! event application, and session switching. Rendering itself lives in the
//! view crate modules; this module only decides what the view shows.

mod apply;
mod auth;
mod bash;
mod commands;
mod heartbeats;
mod keys;
mod lifecycle;
mod model_picker;
mod notes;
mod panels;
mod prompt;
mod queue;
mod sessions_fork;
mod settings;
mod share;
mod stream;

pub(crate) use apply::CompactionAbortNote;
use auth::{McpAuthIntent, PendingModelSignIn, SetModelOutcome};
pub(crate) use bash::BashActivityUpdate;
use bash::{ResyncBash, SideBashRun};
use heartbeats::paused_heartbeat_count;
pub(crate) use heartbeats::HeartbeatsUpdate;
use keys::SelectionAutoScroll;
pub(crate) use model_picker::picker_viewport_rows;
pub(crate) use model_picker::ModelCatalogUpdate;
use panels::pop_superseded_attempt_row;
pub(crate) use panels::ActivityUpdates;
use prompt::PromptOrder;
pub(crate) use prompt::PromptSubmitNote;
pub(crate) use prompt::SubmitBehavior;
use sessions_fork::{create_session, terminal_columns};
use settings::PendingConfirm;
pub(crate) use settings::ReloadNote;
pub(crate) use share::{ShareNote, TracesUploadNote, UpdateNote};
use share::{ShareRun, TraceUploadAllRun, TracesLoginIntent};
use stream::already_running_warning;
pub(crate) use stream::resume_hint_from_stats;
use stream::streaming_tray_hint;
use stream::LoaderTokenTracker;
use stream::SpeedStats;

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use pa_types::daemon::DaemonCommand;
use pa_types::slash_commands::{SlashCommandExecution, SlashCommandRegistry};
use serde_json::{Map, Value};

use crate::bash_view::{BashView, BashViewAction};
use crate::chat::{
    ChatEntry, CompactionReason, CompactionState, MessageBlock, RetryState, StatusKind,
    ToolResultView, WorkingState,
};
use crate::click_dispatch::PressedClick;
use crate::daemon_client::{DaemonClient, DaemonClientEvent};
use crate::daemon_reconnect::RecoveryKind;
use crate::effort_picker::{self, EffortPickerAction};
use crate::export_share::{self, GhAuthStatus, GistOutcome};
use crate::goal_surface::{format_goal_status, tray_goal_label, GoalPanel, GoalView};
use crate::heartbeats_picker::{
    parse_heartbeats, scope_heartbeats, sort_heartbeats, HeartbeatAction, HeartbeatEntry,
    HeartbeatsPicker, HeartbeatsPickerAction,
};
use crate::image_load::LoadedImage;
use crate::image_markers::{
    collect_marked_images, evict_images_to_budget, format_image_marker, image_marker_ids,
};
use crate::info_commands;
use crate::info_panel::{InfoContent, InfoPanelAction};
use crate::interactive::{InteractiveOptions, ModelSelection, SessionSelection};
use crate::keys::key_event_to_id;
use crate::model_picker::{
    CurrentModel, ModelPicker, ModelPickerAction, ModelPickerOptions, ModelSelectionApplied,
};
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

/// Cap on any daemon request awaited on the key-handling path: the UI loop
/// must stay responsive to Ctrl+C while a submission travels (the TS loop
/// never blocks on these — aborts are fire-and-forget, submissions resolve
/// off the render path).
const UI_REQUEST_TIMEOUT_MS: u64 = 10_000;

/// Cap on the detach request during the exit path: the client must exit
/// promptly even when the worker socket is wedged.
const EXIT_DETACH_TIMEOUT_MS: u64 = 600;
/// Cap on the exit-path session-stats fetch (TS `formatResumeHint` inputs):
/// best-effort like the detach, never able to hold the exit open.
const EXIT_STATS_TIMEOUT_MS: u64 = 500;

/// TS `ANTHROPIC_SUBSCRIPTION_AUTH_WARNING` (auth-flows.ts, #2645): the
/// ban-risk warning a completed Anthropic subscription login shows once
/// per session (the settings toggle `warnings.anthropicExtraUsage`
/// gates it).
const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING: &str = "Anthropic subscription auth is active. Usage draws from your plan limits, but Prime Agent identifies as Claude Code and this may violate Anthropic's terms — your account can be restricted or banned. An Anthropic API key avoids the risk. Manage usage at https://claude.ai/settings/usage.";

/// A landed `get_commands` refresh (TS `refreshCommandCatalogForCurrentSession`
/// over `connectionCommands`): the session's `skill:` commands for the
/// autocomplete provider. A response from an older refresh (a rebind raced
/// a fetch) never applies — the epoch drops it.
pub(crate) struct CommandCatalogUpdate {
    pub epoch: u64,
    pub skill_commands: Vec<crate::autocomplete::SlashCommandEntry>,
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
    /// The `/speed` display flag (TS `speedDisplayEnabled`): per-client
    /// runtime state, never persisted; turning it off clears the stats and
    /// the row.
    speed_display_enabled: bool,
    /// Per-session output tok/sec accumulation (TS `speedStats`): output
    /// tokens and wall-clock span summed over completed responses.
    /// `None` until the first recorded sample; a rebind restarts it.
    speed_stats: Option<SpeedStats>,
    /// The session's effective service tier (TS `connectionState.serviceTier`),
    /// seeded from the attach state and kept live by `service_tier_changed`
    /// events; the `/fast` toggle reads it.
    service_tier: Option<String>,
    /// The client-process settings seam (`/settings`, `/fullscreen`);
    /// the composition root supplies it.
    client_settings: Option<std::sync::Arc<dyn crate::client_settings::ClientSettings>>,
    /// The ban-risk warning's once-per-session gate (TS
    /// `anthropicSubscriptionWarningShown`).
    anthropic_subscription_warning_shown: bool,
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
    /// A `/traces upload-all` sweep in flight (TS the arm's
    /// `traceUploadAllAbortController`): the run task and the cancel
    /// handle the clear key fires.
    trace_upload: Option<TraceUploadAllRun>,
    /// Where the upload-all task reports its progress and outcome (the
    /// run loop folds them into the transcript).
    traces_upload_notes: mpsc::UnboundedSender<crate::traces::TraceUploadAllNote>,
    /// A parked `/traces login` (or the enable arm's credential-less
    /// entry): the run loop mounts the inline auth panel and spawns the
    /// flow once; the parked intent leaves with the spawn.
    pending_traces_login: Option<TracesLoginIntent>,
    /// The in-flight traces login's enable intent: taken from the park
    /// when the flow spawns (so a later key cannot spawn a second flow
    /// over the same panel), consumed by the settle.
    traces_login_run: Option<TracesLoginIntent>,
    /// The generation of the in-flight traces login: incremented on
    /// each spawn; a late settle from a superseded run never clears
    /// the newer login's panel (#2845 review).
    traces_login_gen: u64,
    /// Where the background catalog refresh delivers `get_model_catalog`
    /// responses (the run loop folds them into the picker catalog).
    catalog_updates: mpsc::UnboundedSender<ModelCatalogUpdate>,
    /// Where background heartbeat-catalog refreshes deliver their fetches
    /// (the run loop folds them into an open `/heartbeats` view).
    heartbeat_updates: mpsc::UnboundedSender<HeartbeatsUpdate>,
    /// Snapshot chat entries to fold into the view on the next rebuild.
    pending_snapshot: Option<Vec<ChatEntry>>,
    /// One-shot: return the freed heap of the first frame that renders
    /// after an attach fold (the fold itself trims the wire/parse churn;
    /// the first frame's visible-window materialization is its own,
    /// bigger transient — see the draw loop's post-frame trim).
    trim_after_frame: bool,
    /// Snapshot labels (model) for the next rebuild.
    pending_model: Option<String>,
    /// Snapshot model provider for the next rebuild (the attach state's
    /// `model.provider`; `None` when the daemon reports none): the picker
    /// resolves the current-model catalog entry by provider plus id.
    pending_model_provider: Option<String>,
    /// Snapshot tray effort suffix for the next rebuild (the attach
    /// state's level; `None` clears it).
    pending_thinking_suffix: Option<String>,
    /// Snapshot queue state for the next rebuild (attach re-sync).
    pending_queue: Option<crate::queued::QueuedMessages>,
    /// The parked-message browse state (TS `QueueSelection`): which queued
    /// row alt+up/alt+down selected, and its stashed editor draft.
    queue_selection: crate::queued::QueueSelection,
    /// Context usage + cost refreshed from `get_session_stats`.
    context: Option<crate::chrome::ContextUsage>,
    cost_usd: Option<f64>,
    /// The aggregate descendant-subagent spend from the same stats (the
    /// title's `+ $X (subagents)` suffix; `None` on daemons without the
    /// split fields).
    subagents_cost_usd: Option<f64>,
    /// Rows of the most recent `/list` (for `/switch <n>`).
    list_rows: Vec<Value>,
    pub(crate) turn_active: bool,
    /// Completed turns observed on this connection. A prompt ACK may arrive
    /// after its entire streamed turn; it must not restart the loader then.
    turn_ends_seen: u64,
    /// The last submitted prompt's expected completion in wire order.
    last_prompt_turn_end: u64,
    /// The session's queue delivery mode (TS `steeringMode`, the state's
    /// `steeringMode`): `all` delivers the queued steering prefix as one
    /// batched turn at the boundary; `one-at-a-time` one per turn. The
    /// product default is `all`. Cached at every connection-state read
    /// so the queued-input adoption event reports the mode without a
    /// synchronous fetch.
    pub(crate) steering_mode: String,
    /// The chat index of the assistant message still streaming.
    streaming_index: Option<usize>,
    /// The loader's token accounting (TS `AgentActivityTracker`), reported
    /// monotonically within a run.
    working_tokens: LoaderTokenTracker,
    /// The turn already surfaced its error (a failed assistant message or a
    /// retry-exhausted banner); the `turn_end` error stays silent then (TS
    /// renders the failure once, through the message or the retry banner).
    turn_error_shown: bool,
    /// Tool cards awaiting their final result (TS `pendingTools`): a
    /// streamed call registers at its `message_update` frame or at
    /// `tool_execution_start`, the final result unregisters, and the run's
    /// failed final frame settles every pending card with the failure text
    /// (late frames land on nothing — TS `resetPendingToolState`).
    pending_tools: std::collections::HashSet<String>,
    /// Tool calls settled by a failed final frame, card or not: the run's
    /// late tool frames land on nothing (a new assistant message re-arms a
    /// reused id with a fresh card, the way TS's fresh component does).
    aborted_tools: std::collections::HashSet<String>,
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
    /// A model selection parked on the provider's sign-in (TS
    /// `ensureModelProviderConfigured`): the picker applied a model whose
    /// provider is not signed in, the login flow runs, and a successful
    /// login retries the switch automatically.
    pending_model_sign_in: Option<PendingModelSignIn>,
    /// The inline auth panel's request channel (the login flows drive the
    /// panel through it; the run loop owns the receiving side and folds
    /// each request into the mounted panel).
    auth_panel_notes: mpsc::UnboundedSender<crate::auth_panel::AuthPanelRequest>,
    /// The running panel login's cooperative cancel signal (#2770):
    /// armed only by the flows that check it between their poll steps
    /// (the codex subscription login); Esc/ctrl+c on the mounted panel
    /// marks it and unmounts, and a cancelled flow never writes its
    /// credential.
    auth_panel_cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    /// `/update`: the installer funnel the composition root owns. The run
    /// is out-of-band (a spawned task with the output captured) — the
    /// TUI stays mounted, the daemon keeps running, and the outcome lands
    /// through [`Self::update_notes`].
    update_commands: Option<crate::update_command::UpdateCommandsHandle>,
    /// The background `/update` run's outcome channel (the spawned task
    /// sends, the run loop folds the note row in).
    update_notes: mpsc::UnboundedSender<UpdateNote>,
    /// A confirmed `/update` whose download+install is still in flight:
    /// a second run is refused until the outcome lands.
    update_in_flight: bool,
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
    /// `getScopedHeartbeats`): drives the activity dock's heartbeat
    /// group and seeds the `/heartbeats` view; refreshed by
    /// `heartbeats_changed`.
    heartbeat_catalog: Vec<HeartbeatEntry>,
    /// At most one background heartbeat refresh runs at a time (the
    /// daemon-wide broadcasts can burst); concurrent requests would
    /// stack load on the supervisor.
    heartbeat_refresh_in_flight: bool,
    /// A burst arrived while a refresh was in flight: one trailing
    /// coalesced refresh follows the landing response.
    heartbeat_refresh_queued: bool,
    /// Monotonic epoch of the newest heartbeat refresh; an older
    /// response never overwrites a newer catalog.
    heartbeat_refresh_epoch: u64,
    /// Where background `get_commands` refreshes deliver the session's
    /// skill commands (the run loop folds them into the autocomplete
    /// provider).
    command_updates: mpsc::UnboundedSender<CommandCatalogUpdate>,
    /// Monotonic epoch of the newest command-catalog refresh; an older
    /// response (a rebind raced the fetch) never applies to the current
    /// session's provider.
    command_refresh_epoch: u64,
    /// The session's fetched skill commands (the `enableSkillCommands`
    /// toggle re-applies them without a daemon round trip).
    skill_commands_cache: Vec<crate::autocomplete::SlashCommandEntry>,
    /// The current Python `bash()` registry snapshot from the owning kernel.
    bash_activities: Value,
    /// Monotonic id of the latest issued kernel-bash list request; a late
    /// response from an older request must not repaint a newer snapshot.
    bash_list_epoch: u64,
    bash_updates: mpsc::UnboundedSender<BashActivityUpdate>,
    /// The subagent summary line holds keyboard focus.
    subagents_focused: bool,
    activity_group: crate::chrome::ActivityGroup,
    /// A scope-back reopen (the agents view's parent/escape key handed
    /// the pane back from the dock's Subagents panel) restores the dock
    /// focus once, at the first summary after the attach: the roster is
    /// seeded by then, so the panel's own group is actionable at the
    /// first paint or the editor keeps the focus (a later roster must
    /// not yank the keyboard back mid-composition).
    pending_dock_focus_restore: bool,
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
    /// Compaction-abort outcomes from the backgrounded request (the abort
    /// supervision's UI recovery): a failed abort clears the stuck loader.
    compaction_abort_notes: mpsc::UnboundedSender<CompactionAbortNote>,
    /// The ordered inbox the single submit worker drains (see
    /// [`PromptOrder`]): one in-flight request at a time keeps the wire
    /// in submit order while the key path stays free of the round trip.
    /// The outcome channel is not held here — the worker (spawned in
    /// [`Self::open`]) owns its sender, and the run loop owns the
    /// receiving side.
    prompt_orders: mpsc::UnboundedSender<PromptOrder>,
    /// Monotonic submit generation (TS `inputSubmissionGeneration`): every
    /// submit bumps it, and a failed one's draft-restore right dies under
    /// any newer submit.
    input_submission_generation: u64,
    /// Armed prompt round trips (one per spawned request): the headless
    /// idle and exit gates treat an in-flight submit as busy — the inline
    /// submit held those gates by blocking the loop until the ack landed.
    prompt_in_flight: usize,
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
    /// TS #2458 `daemonClosingNotice`: the reason the daemon last
    /// announced itself closing; cleared once a fresh attach
    /// (re)establishes the connection. An announced `shutdown` arms the
    /// bounded shutdown recovery, so a bare session stop without a notice
    /// never routes into a reconnect.
    pub(crate) daemon_closing_notice: Option<String>,
    /// The session whose direct worker link just died; the interactive
    /// loop arms the re-attach driver from it (TS `connection_status:
    /// "reconnecting"`).
    pub(crate) transport_lost: Option<String>,
    /// The current active id of this session after a `session_binding`
    /// supersede notice; the interactive loop re-attaches to it so event
    /// routing follows the session's new worker.
    pub(crate) pending_rebind: Option<String>,
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
    /// When the mounted run started (the settle telemetry's duration
    /// bucket).
    user_bash_started_at: Option<std::time::Instant>,
    user_bash_counter: u64,
    /// The attached snapshot's bash slot state (TS
    /// `applyConnectionStateSnapshot` patches `isBashRunning`): consumed
    /// by the next transcript rebuild — a same-session resync runs the
    /// `renderResyncedSession` bashFinished edge off it.
    resync_bash: Option<ResyncBash>,
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
    /// The `/mcp` view's internal auth resolution (its Enter on a
    /// connection, or the pasteable service's paste flow): the auth args
    /// plus the inline auth panel's title; the loop mounts the panel and
    /// spawns the command through the auth seam, never through the
    /// typed-command path.
    pending_mcp_auth: Option<McpAuthIntent>,
    /// The Tab-interception path restored the stashed browse draft into
    /// the editor when it opened the picker, so the editor holds the
    /// user's draft, not the command's typed partial: a picker apply
    /// fulfills the command but must keep the draft.
    picker_restored_draft: bool,
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
    /// TS `fullscreenPressedHyperlink`: the link under the last plain left
    /// press; a release without a drag opens it.
    pub(crate) pressed_hyperlink: Option<String>,
    /// TS `fullscreenLeftMouseDragged`: the left press turned into a drag,
    /// so its release ends the selection instead of opening the link or
    /// firing the pressed click.
    pub(crate) left_mouse_dragged: bool,
    /// Links opened by clicks this run (headless runs have no terminal to
    /// hand a browser to; the verifier reads these).
    pub(crate) opened_urls: Vec<String>,
    /// The click target under the last plain left press (TS
    /// `fullscreenPressedClick`): the release fires it when it lands on
    /// the same row without a drag between and no hyperlink covers the
    /// press.
    pub(crate) pressed_click: Option<PressedClick>,
    /// Whether this run already reported its first click-driven
    /// interaction.
    click_adoption_emitted: bool,
}

/// Why one transcript rebuild runs (TS: a session rebind renders through
/// `renderCurrentSessionState`, a same-session resync through
/// `renderResyncedSession` — the bash slot survives only the resync).
/// The reattach outcome for `reattach_after_recovery`: the budget expiry
/// (a queued attach waiting out a slow restore, §10.4) is a RETRY
/// outcome — the reconnect driver schedules its next attempt; only a
/// true attach error is an `Err`.
pub(crate) enum ReattachOutcome {
    Attached,
    AttachBudgetExceeded,
}

pub(crate) enum RebuildKind {
    /// A new session took the view's place (`/new`, `/switch`, startup):
    /// the previous session's held cards die with its transcript.
    Rebind,
    /// The same session re-attached after an update restart (§10): the
    /// held cards stay mounted and the `bashFinished` edge settles a run
    /// that ended behind the dead link.
    Resync,
}

/// Where a compact-dock focus hand-off comes from (TS
/// `focusSubagentSummary`, shared by `app.subagents.focus` and the
/// editor's move-below-prompt hook): the selectability gate differs per
/// caller.
enum DockFocusSource {
    /// The editor's Down at the prompt's end (TS `onMoveBelowPrompt`
    /// -> `focusSubagentSummary`): the subagents box's affordance.
    PromptDown,
    /// The `app.subagents.focus` key: any rendered dock group.
    Shortcut,
}

/// How the attach settles the dock's data before the rebuild renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DockFold {
    /// Clear and fold the first `heartbeats_list` and `list_kernel_bash`
    /// responses into the session before the attach returns: the dock
    /// (the panel and its divider under the prompt bar) is first-frame
    /// geometry — its visibility must be final when the first content
    /// frame renders (open, switch, rebind), never a late layout shift.
    FirstFrame,
    /// Clear and hand the dock to the background refreshes: a brand-new
    /// session (`/new`) owns nothing, so its dock is deterministically
    /// empty — the fold cannot change geometry, and waiting on two
    /// registry reads would only delay the new chat's first frame.
    Fresh,
    /// Hold the dock's data and let the background refreshes update it: a
    /// same-session re-attach of an already-up surface (the §10.4
    /// recovery, the session reconnect) must not flicker its dock away,
    /// and the attach's budget must cover the attach alone.
    Held,
}

impl SessionUi {
    /// Take the one-shot post-first-frame trim request (the draw loop
    /// consumes it right after the frame it armed paints).
    pub(crate) fn take_trim_after_frame(&mut self) -> bool {
        std::mem::take(&mut self.trim_after_frame)
    }

    /// Hand the keyboard focus to the compact dock on its selected group:
    /// the `app.subagents.focus` shortcut and every dock panel's close
    /// restore (the operator's 2026-09-26 ruling: leaving a panel lands
    /// on the panel's own dock item, never the prompt bar). The dock owns
    /// the hand-off exactly while it renders — a session with nothing to
    /// show keeps the dock unmounted and the focus where it was; every
    /// group the row renders is traversable, empty ones included, so no
    /// feed gate remains here.
    fn focus_activity_dock(&mut self, view: &mut AgentView) -> bool {
        let dock = self.activity_dock_state();
        if !dock.visible() {
            return false;
        }
        if !dock.groups().contains(&self.activity_group) {
            // Only the goal group leaves with its row: the selection
            // steps back to the group that now ends the row.
            self.activity_group =
                dock.step(self.activity_group, crate::chrome::ActivityDirection::Prev);
        }
        self.subagents_focused = true;
        self.update_subagent_summary(view);
        true
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

    fn session_display(&self) -> String {
        self.session_name
            .clone()
            .unwrap_or_else(|| crate::chrome::display_name(&self.cwd.to_string_lossy()))
    }

    /// The active model's provider from the daemon's state (TS
    /// `getCurrentModel().provider`); best-effort, silent on failure.
    pub(crate) async fn current_model_provider(&mut self) -> Option<String> {
        let state = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetState {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await
            .ok()?;
        state
            .get("model")?
            .get("provider")?
            .as_str()
            .map(str::to_string)
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

    /// How many prompt round trips are armed (see
    /// [`Self::prompt_in_flight`]): the headless idle and exit gates read
    /// it so a submit whose ack has not landed never reads as idle.
    pub(crate) fn prompt_submits_in_flight(&self) -> usize {
        self.prompt_in_flight
    }
}

impl SessionUi {
    /// Whether a `/reload` is in flight (the run loop must not end before
    /// its outcome row lands).
    pub(crate) fn reload_pending(&self) -> bool {
        self.reload.is_some()
    }

    /// Whether the `/mcp` view parked an auth request for the loop to
    /// spawn (checked after each dispatched key).
    pub(crate) fn pending_mcp_auth(&self) -> bool {
        self.pending_mcp_auth.is_some()
    }

    /// The `tui exit` reason recorded at the point the loop stopped.
    pub(crate) fn exit_reason(&self) -> &'static str {
        self.exit_reason
    }
}
