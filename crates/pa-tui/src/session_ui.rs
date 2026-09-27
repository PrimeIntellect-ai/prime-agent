//! Live per-session UI state for the interactive loop: the daemon-client
//! side of one attached session — prompt submission, slash commands, streamed
//! event application, and session switching. Rendering itself lives in the
//! view crate modules; this module only decides what the view shows.

mod apply;
mod auth;
mod bash;
mod heartbeats;
mod keys;
mod model_picker;
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
use sessions_fork::terminal_columns;
use settings::PendingConfirm;
pub(crate) use settings::ReloadNote;
pub(crate) use share::{ShareNote, TracesUploadNote};
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
    /// Create/attach per the session selection and return the live state.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn open(
        client: DaemonClient,
        options: &InteractiveOptions,
        notes: mpsc::UnboundedSender<String>,
        compaction_abort_notes: mpsc::UnboundedSender<CompactionAbortNote>,
        prompt_notes: mpsc::UnboundedSender<PromptSubmitNote>,
        share_notes: mpsc::UnboundedSender<ShareNote>,
        reload_notes: mpsc::UnboundedSender<ReloadNote>,
        traces_upload_notes: mpsc::UnboundedSender<crate::traces::TraceUploadAllNote>,
        catalog_updates: mpsc::UnboundedSender<ModelCatalogUpdate>,
        auth_panel_notes: mpsc::UnboundedSender<crate::auth_panel::AuthPanelRequest>,
        activity_updates: ActivityUpdates,
    ) -> Result<SessionUi> {
        let active_session_id = match &options.session {
            SessionSelection::New => create_session(&client, options, None).await?,
            SessionSelection::Attach(id) => id.clone(),
            SessionSelection::Resume(_) => {
                create_session(&client, options, Some(&options.session)).await?
            }
        };
        // The single prompt-submit worker (see [`PromptOrder`]): it owns
        // the ordered drain, so submit order on the wire is submit order
        // at the channel, and no per-submit task can reorder two rapid
        // submissions. The worker lives with the orders channel — the
        // session drops its sender and the worker's recv() ends, so the
        // task never outlives the run (the agents-view handoff and the
        // exit both drop the session).
        let (orders_tx, orders_rx) = mpsc::unbounded_channel::<PromptOrder>();
        tokio::spawn(Self::prompt_submit_worker(orders_rx, prompt_notes.clone()));
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
            heartbeat_updates: activity_updates.heartbeats,
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
                .is_none_or(|settings| settings.fullscreen()),
            service_tier: None,
            speed_display_enabled: false,
            speed_stats: None,
            client_settings: options.client_settings.clone(),
            anthropic_subscription_warning_shown: false,
            active_side_question_id: None,
            side_question_counter: 0,
            share: None,
            reload: None,
            reload_notes,
            share_notes,
            trace_upload: None,
            traces_upload_notes,
            pending_traces_login: None,
            traces_login_run: None,
            traces_login_gen: 0,
            pasted_images: BTreeMap::default(),
            next_image_marker_id: 1,
            pending_snapshot: None,
            trim_after_frame: false,
            pending_model: None,
            pending_model_provider: None,
            pending_thinking_suffix: None,
            pending_queue: None,
            queue_selection: crate::queued::QueueSelection::default(),
            context: None,
            cost_usd: None,
            subagents_cost_usd: None,
            list_rows: Vec::new(),
            turn_active: false,
            turn_ends_seen: 0,
            last_prompt_turn_end: 0,
            steering_mode: "all".to_string(),
            streaming_index: None,
            working_tokens: LoaderTokenTracker::default(),
            turn_error_shown: false,
            pending_tools: HashSet::default(),
            aborted_tools: HashSet::default(),
            last_assistant_text: None,
            osc_sink: crate::clipboard::OscSink::Stdout,
            pending_confirm: None,
            traces: options.traces.clone(),
            provider_auth: options.provider_auth.clone(),
            pending_model_sign_in: None,
            auth_panel_notes,
            auth_panel_cancel: None,
            pending_update: None,
            update_commands: options.update_commands.clone(),
            exit_requested: false,
            open_agents_view: false,
            scoped_agents_view: None,
            roster: Vec::new(),
            heartbeat_catalog: Vec::new(),
            heartbeat_refresh_in_flight: false,
            heartbeat_refresh_queued: false,
            heartbeat_refresh_epoch: 0,
            command_updates: activity_updates.commands,
            command_refresh_epoch: 0,
            skill_commands_cache: Vec::new(),
            bash_activities: serde_json::json!({"activities": []}),
            bash_list_epoch: 0,
            bash_updates: activity_updates.bash,
            subagents_focused: false,
            activity_group: crate::chrome::ActivityGroup::Subagents,
            pending_dock_focus_restore: false,
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
            compaction_abort_notes,
            prompt_orders: orders_tx,
            input_submission_generation: 0,
            prompt_in_flight: 0,
            transcript_stale: false,
            telemetry: options.telemetry.clone(),
            scroll_adoption_emitted: false,
            exit_reason: "daemon_closed",
            reconnect: None,
            daemon_closing_notice: None,
            transport_lost: None,
            pending_rebind: None,
            reconnection_failed: None,
            exit_guard: crate::exit_guard::ExitGuard::new(),
            escape_repeat_action: None,
            escape_repeat_until: None,
            user_bash_running: false,
            user_bash_card: None,
            user_bash_started_at: None,
            user_bash_counter: 0,
            resync_bash: None,
            side_bash: None,
            side_bash_discarded: None,
            side_bash_counter: 0,
            suspend_requested: false,
            pending_mcp_auth: None,
            picker_restored_draft: false,
            suspend_adoption_emitted: false,
            selection_auto_scroll: None,
            selection_adoption_emitted: false,
            copies: Vec::new(),
            pressed_hyperlink: None,
            left_mouse_dragged: false,
            opened_urls: Vec::new(),
            pressed_click: None,
            click_adoption_emitted: false,
        };
        session
            .attach_session(&active_session_id, DockFold::FirstFrame)
            .await
            .with_context(|| format!("attaching session {active_session_id}"))?;
        // The scope-back reopen's restore arms AFTER the attach: every
        // later attach's rebind reset clears an armed restore (focus
        // returns to the editor, TS `resetSubagentSummary`), so the
        // initial attach must carry the reopen's own restore past that
        // reset to the first summary.
        session.pending_dock_focus_restore = options.restore_dock_focus;
        Ok(session)
    }

    /// Spec §10.2-§10.5: reattach after a restart. The fresh client
    /// (connected to the successor supervisor) replaces the dead one; the
    /// attach goes by DURABLE session id, so the slice-5 queued-attach
    /// contract absorbs any restore still in flight (the §10.3 hello's
    /// `update_resume.complete` is surfaced as a banner line). The
    /// transcript rebuilds from the attach snapshot - the same machinery
    /// `/switch` uses - and the recovery's row lands after it.
    ///
    /// `kind` names the driver that owns the recovery: the update restart
    /// paints its §10.5 banner, while a lost or announced-shutdown window
    /// (TS #2458) reports the restart version-honestly instead.
    pub(crate) async fn reattach_after_recovery(
        &mut self,
        client: DaemonClient,
        view: &mut AgentView,
        kind: RecoveryKind,
    ) -> Result<ReattachOutcome> {
        // One reattach attempt's budget (§10.4: a queued attach can
        // legitimately wait out a slow restore — the budget's expiry is a
        // RETRY outcome, never a fatal one). The bound lives INSIDE this
        // function — a caller-side timeout would cancel this future
        // mid-attach and skip the failure-path `close()` below, leaking
        // the half-installed client's supervisor connection and reader.
        const REATTACH_BUDGET: Duration = Duration::from_secs(30);
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
            // A failed reattach must not leave the half-installed client
            // (its supervisor connection and reader task) running for the
            // process's lifetime: close it, and the reconnect driver
            // installs a fresh one on its next attempt.
            self.client.hard_close();
            anyhow::bail!("the session's durable id is unknown; cannot reattach");
        }
        let attach = tokio::time::timeout(
            REATTACH_BUDGET,
            self.attach_session(&durable, DockFold::Held),
        )
        .await;
        match attach {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                // A failed reattach must not leave the half-installed
                // client (its supervisor connection and reader task)
                // running: dispose it outright (the writer drops, the
                // socket shuts down, the reader EOFs), and the reconnect
                // driver installs a fresh one on its next attempt.
                self.client.hard_close();
                let what = match kind {
                    RecoveryKind::Update => "after the update",
                    RecoveryKind::Lost | RecoveryKind::Shutdown => "after the restart",
                };
                return Err(error.context(format!("reattaching session {durable} {what}")));
            }
            Err(_) => {
                // A wedged attach outlived the budget (§10.4: a queued
                // attach can legitimately wait out a slow restore): same
                // disposal, but the expiry is a RETRY outcome — the
                // driver's next attempt owns the recovery, never a fatal
                // exit.
                self.client.hard_close();
                return Ok(ReattachOutcome::AttachBudgetExceeded);
            }
        }
        // Flush the attach snapshot BEFORE the banner lands: `rebuild_view`
        // replaces the transcript from the snapshot, so the banner must come
        // after it to survive the rebuild (§10.5's visible end state).
        self.rebuild_view(view, RebuildKind::Resync);
        match kind {
            RecoveryKind::Update => match complete {
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
            },
            RecoveryKind::Lost | RecoveryKind::Shutdown => {
                // TS #2458 `formatDaemonReconnectBanner`: the recovered
                // window reports the restart version-honestly.
                let daemon_version = self
                    .client
                    .hello()
                    .get("appVersion")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let (text, status_kind) = crate::daemon_reconnect::reconnect_banner(
                    daemon_version.as_deref(),
                    env!("CARGO_PKG_VERSION"),
                );
                view.push_entry(crate::chat::ChatEntry::Status {
                    text,
                    kind: status_kind,
                });
            }
        }
        self.dirty = true;
        Ok(ReattachOutcome::Attached)
    }

    /// Detach the current session and attach `id`, rebuilding the transcript
    /// from the slim attach snapshot.
    ///
    /// The attach itself travels over a direct worker link when the
    /// supervisor issues a ticket (best effort: every failure keeps the
    /// supervisor-routed path, and a failed direct attach retries once over
    /// the supervisor).
    ///
    /// The NEW attach lands before the old id detaches: a failed re-attach
    /// (a replacement mid-teardown, a dead worker) must not strand the pane
    /// locally bound but server-detached - the previous subscription stays
    /// until the new one exists, and the next supersede notice or the
    /// submit-path retry re-attaches when a worker can serve the session.
    pub(crate) async fn attach_session(
        &mut self,
        active_session_id: &str,
        dock_fold: DockFold,
    ) -> Result<()> {
        let previous = self.active_session_id.clone();
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
            rest: Map::default(),
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
        let attach = attach_data_from_response(data)?;
        // The bash slot follows the attached session's live state (TS
        // `applyConnectionStateSnapshot` patches `isBashRunning`): the
        // captured state drives the next rebuild's resync edge. The
        // mounted card id survives the patch (TS keeps
        // `activeBashComponent` tracked) — the rebuild's kind decides
        // its fate.
        let state = attach.snapshot.get("state");
        let resync_bash = ResyncBash {
            was_running: self.user_bash_running,
            snap_running: state
                .and_then(|state| state.get("isBashRunning"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            snap_streaming: state
                .and_then(|state| state.get("isStreaming"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        self.user_bash_running = resync_bash.snap_running;
        self.resync_bash = Some(resync_bash);
        let reconstructed = reconstruct(&attach);
        let mounted_session_changes = previous != attach.active_session_id;
        self.active_session_id = attach.active_session_id;
        // The new attachment exists (the snapshot above rebuilt from it):
        // retire the superseded id's subscription now, addressed by the
        // captured previous id (the detach must target the OLD address,
        // not the id the pane just adopted).
        if !previous.is_empty() && previous != self.active_session_id {
            let _ = self
                .bounded_request(
                    Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                    DaemonCommand::Detach {
                        id: None,
                        active_session_id: Some(previous),
                        rest: Map::default(),
                    },
                )
                .await;
        }
        self.session_id = reconstructed.session_id;
        // The closing notice is per-connection (TS #2458: it clears on
        // every attach): a later bare session stop must not route into a
        // stale shutdown recovery's reconnect hang.
        self.daemon_closing_notice = None;
        self.session_name.clone_from(&reconstructed.session_name);
        self.service_tier.clone_from(&reconstructed.service_tier);
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
        // A rebind drops an armed scope-back restore with the session it
        // belonged to: the arriving session's focus is the editor's
        // (TS `resetSubagentSummary`), never the left session's
        // panel-exit state.
        self.pending_dock_focus_restore = false;
        self.subscribe_roster().await;
        // The dock's heartbeat rows follow `dock_fold` (the enum's
        // contract): a first-content-frame attach folds the fresh fetch
        // BEFORE the attach returns — the dock's visibility (the panel
        // and its divider under the prompt bar) is first-frame geometry,
        // never a late layout shift (the operator's 2026-09-26
        // zero-shift ruling). TS guarantees the same for its dock: the
        // counts seed from the attach snapshot (`seedSubagentSummary`)
        // and the roster subscription is awaited before the first
        // content render; TS's own heartbeat fetch stays fire-and-forget
        // only because its summary line renders no heartbeat rows.
        match dock_fold {
            DockFold::FirstFrame | DockFold::Fresh => self.heartbeat_catalog.clear(),
            // The held dock keeps its data: an already-up surface's dock
            // must not flicker away while the background refresh runs.
            DockFold::Held => {}
        }
        match dock_fold {
            DockFold::FirstFrame => self.fetch_heartbeat_catalog().await,
            DockFold::Fresh | DockFold::Held => self.spawn_heartbeat_refresh(),
        }
        // The slash-command catalog is session-scoped too (TS
        // `refreshConnectionCatalog` fetches `get_commands` on every
        // rebind): the skill commands land in the autocomplete provider
        // when the response arrives.
        self.spawn_command_catalog_refresh();
        // The dock's bash rows follow the same `dock_fold` contract; the
        // capability gate matches the background refresh (older daemons
        // never see the request), and a failed fold fetch leaves the
        // cleared registry (the 2s poll refills).
        match dock_fold {
            DockFold::FirstFrame | DockFold::Fresh => {
                self.bash_activities = serde_json::json!({"activities": []});
            }
            // The held dock keeps its registry for the same reason it
            // keeps the heartbeat catalog above.
            DockFold::Held => {}
        }
        self.activity_group = crate::chrome::ActivityGroup::Subagents;
        match dock_fold {
            DockFold::FirstFrame => self.fetch_bash_activities().await,
            DockFold::Fresh | DockFold::Held => self.spawn_bash_activity_refresh(),
        }
        self.pending_model = reconstructed.model_id;
        self.pending_model_provider = reconstructed.model_provider;
        self.pending_thinking_suffix = reconstructed.thinking_suffix;
        self.last_assistant_text = reconstructed
            .chat
            .iter()
            .rev()
            .find_map(|entry| match entry {
                ChatEntry::Assistant(message) => {
                    message.blocks.iter().rev().find_map(|block| match block {
                        MessageBlock::Text(text) => Some(text.clone()),
                        MessageBlock::Thinking(_) => None,
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
        let streaming = attach.snapshot.get("state").is_some_and(|state| {
            ["isStreaming", "isCompacting"]
                .iter()
                .any(|flag| state.get(flag).and_then(Value::as_bool).unwrap_or(false))
        });
        self.turn_active = streaming;
        self.streaming_index = None;
        // The turn-end watermark restarts only when the mounted session
        // CHANGES: the ends the new stream will see belong to the newly
        // mounted session, and an end owed by the detached session's stream
        // (a turn whose submit outlived the switch — the daemon keeps
        // running it, and its end never arrives on this stream) must not
        // pin the watermark. Without the reset a later prompt's ack would
        // re-arm `turn_active` against an end count that can never catch
        // up, and the idle gates would wait for an end that will never
        // come (the submit-outlived wedge). A SAME-SESSION rebind
        // (recovery, reconnect) keeps the counters: its stream counts ends
        // for the same session, and a prompt note that straddled the
        // recovery still carries comparable values — resetting there would
        // orphan in-flight acks the same way (a turn that already ended
        // before the idle snapshot would re-arm `turn_active` with no
        // `TurnEnded` left to clear it). The mounted snapshot's
        // `streaming` flag carries the live-turn state across the attach.
        if mounted_session_changes {
            self.turn_ends_seen = 0;
            self.last_prompt_turn_end = 0;
        }
        // TS `applyConnectionStateSnapshot` -> `bindPromptStashSession`: the
        // stash state follows the stable id of the session now rendered.
        // The initial attach and every in-place switch (`/switch`, `/new`)
        // rebind through here; a rebind hydrates the session's stashed
        // images into the paste registry.
        let stash_session_id = self.session_id.clone();
        self.bind_prompt_stash_session(&stash_session_id);
        // The attach fold held the wire frame, its decoded tree, and the
        // folded transcript together; the frame and tree drop here, so
        // return their freed heap to the OS instead of keeping the load's
        // peak resident for the TUI's lifetime.
        pa_types::memory_release::trim_freed_heap();
        // The rebuild's first frame materializes the visible window —
        // its wrap/render churn is the TUI's own transient on top of the
        // fold's; arm the post-frame trim so that churn returns too
        // instead of riding the arenas for the process lifetime.
        self.trim_after_frame = true;
        Ok(())
    }

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

    /// Fold the pending snapshot into the view (fresh transcript, footer
    /// labels). Called after attach and after every session switch.
    pub(crate) fn rebuild_view(&mut self, view: &mut AgentView, kind: RebuildKind) {
        let resync_bash = self.resync_bash.take();
        // The held cards' fate diverges by rebuild: a rebind drops them
        // with the old transcript (TS `resetCurrentSessionRenderState`), a
        // resync keeps them mounted above the indicator (TS
        // `renderResyncedSession` re-attaches `pendingBashComponents`).
        let held_bash = matches!(kind, RebuildKind::Resync)
            .then(|| std::mem::take(&mut view.pending_bash))
            .unwrap_or_default();
        // A rebind replaces the whole view: the previous session's open
        // bash view dies with its transcript instead of owning keys over
        // the new session's registry. Sessions are independent (TS
        // `rebindCurrentSession`): a rebind also restarts the tok/sec
        // stats and clears the readout left over from the previous session.
        if matches!(kind, RebuildKind::Rebind) {
            view.bash_view = None;
            // The goal panel dies with the old session too: it is a
            // snapshot of the previous session's goal state, and until
            // the new session's own `goal_update` lands it would keep
            // owning the frame over the rebind with stale content.
            view.goal_panel = None;
            // The read-only info panel dies the same death: it holds the
            // previous session's fetched document, and a stale panel
            // would keep consuming keys over the new session.
            view.info_panel = None;
            self.speed_stats = None;
            view.chrome.speed_text = None;
        }
        view.clear_chat();
        // The rebuilt transcript invalidates the tracked status row.
        self.last_status_index = None;
        // The rebuild drops the previous run's pending-tool map (TS
        // `resetPendingToolState` at the rebuild boundary).
        self.pending_tools.clear();
        self.aborted_tools.clear();
        if let Some(items) = self.pending_snapshot.take() {
            for entry in items {
                view.push_entry(entry);
            }
        }
        // The rebuild re-registers the live tool cards the way TS
        // `restoreStreamingMessageFromSnapshot` does (the resumed turn's
        // streamed calls re-enter the pending map): a post-reconnect
        // failure frame can still settle them. Settled cards (a final
        // result attached) stay out.
        for entry in &view.chat {
            if let ChatEntry::Tool(card) = entry {
                if card.result.is_none() || card.result_partial {
                    self.pending_tools.insert(card.id.clone());
                }
            }
        }
        if let Some(model) = self.pending_model.take() {
            view.chrome.model_id = Some(model);
            view.chrome.model_provider = self.pending_model_provider.take();
        }
        // The tray's effort suffix moves with the same snapshot: an
        // attach's state either carries the session's level or reports a
        // model without reasoning, and the bare name wins in both cases.
        view.chrome.thinking_suffix = self.pending_thinking_suffix.take();
        view.queued = self.pending_queue.take().unwrap_or_default();
        // A rebuilt view starts from the snapshot's queue: any browse
        // selection belonged to the previous queue and drops (TS
        // `resetCurrentSessionRenderState` clears the selection).
        let _ = self.queue_selection.reset();
        view.queue_selected = None;
        view.chrome.chat_name = self.session_display();
        view.chrome.context = self.context;
        view.chrome.cost_usd = self.cost_usd;
        view.chrome.subagents_cost_usd = self.subagents_cost_usd;
        self.update_subagent_summary(view);
        // The rebuilt transcript invalidates the announcement row tracking;
        // the goal state itself carries over (seeded at attach).
        self.goal_view.reset_row_tracking();
        self.sync_goal_tray(view);
        self.sync_activity_dock(view);
        view.pending_bash = held_bash;
        // The rebuild decides the mounted card's fate: a rebind drops it
        // with the old transcript (TS `resetCurrentSessionRenderState`
        // settles it cancelled and clears the hold — invisible after the
        // clear), a resync runs the `renderResyncedSession` bashFinished
        // edge: a run that ended behind the dead link settles its card
        // with an unknown exit, flushes the hold when no turn is live,
        // and releases the pane's side run (its bash_end never arrives —
        // a transient run is not in the snapshot).
        match kind {
            RebuildKind::Rebind => {
                self.user_bash_card = None;
                self.user_bash_started_at = None;
            }
            RebuildKind::Resync => {
                if let Some(resync) = resync_bash {
                    let bash_finished = resync.was_running && !resync.snap_running;
                    if bash_finished {
                        if let Some(card_id) = self.user_bash_card.take() {
                            if let Some(index) = view.chat.iter().position(|entry| {
                                matches!(entry, ChatEntry::BashExecution(card) if card.id == card_id)
                            }) {
                                if let Some(ChatEntry::BashExecution(card)) =
                                    view.chat.get_mut(index)
                                {
                                    card.set_complete(None, false, false, None);
                                }
                                view.mark_entry_stale(index);
                            } else if let Some(card) = view
                                .pending_bash
                                .iter_mut()
                                .find(|card| card.id == card_id)
                            {
                                card.set_complete(None, false, false, None);
                            }
                            self.user_bash_started_at = None;
                            // TS flushes inside the active-component branch:
                            // a side run (no mounted card) never flushes.
                            if !resync.snap_streaming {
                                self.flush_pending_bash(view);
                            }
                        }
                        if self.side_bash.take().is_some() {
                            if let Some(pane) = view.side_pane.as_mut() {
                                if let Some(bash) = pane.bash.as_mut() {
                                    bash.running = false;
                                }
                            }
                        }
                        self.side_bash_discarded = None;
                    }
                }
            }
        }
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
        // An open `/heartbeats` picker follows the rebuilt session's
        // catalog (the channel fold's `apply_catalog` path, which the
        // attach-time inline fold replaced): without this, a rebind
        // leaves the picker showing the previous session's rows, and
        // its Manage actions would target the stale active session.
        if let Some(picker) = view.heartbeats_picker.as_mut() {
            picker.apply_catalog(self.heartbeat_catalog.clone(), None);
        }
        // The brand splash is the EMPTY chat's header (TS mounts
        // `BrandSplashHeader` in `ui.start()`): a rebuild that folds a
        // non-empty transcript suppresses it — the chat opened or
        // switched directly into content, where TS's own direct opens
        // attach before mount and the tail-anchored viewport scrolls the
        // splash out of reach — while every rebuild into an empty chat
        // keeps it (a new session shows its header; the incremental
        // first-turn growth never passes through here, so a new chat's
        // splash scrolls away exactly like TS).
        view.splash_suppressed = !view.chat.is_empty();
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
                    rest: Map::default(),
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
        // The title shows the session's own spend plus the aggregate of
        // its subagents (`ownCost`/`subagentsCost`, the split of the
        // full session+subagents total): the TS active-region `cost`
        // drops pre-compaction spend, which reads as an inaccurate
        // title after every compaction. The split lands together; a
        // daemon without `ownCost` serves the combined `totalCost`
        // (or the TS `cost`), and a subagent suffix next to that would
        // double-count — the suffix only rides the split's own half.
        if let Some(own) = data.get("ownCost").and_then(Value::as_f64) {
            self.cost_usd = Some(own);
            self.subagents_cost_usd = data.get("subagentsCost").and_then(Value::as_f64);
        } else {
            self.cost_usd = data
                .get("totalCost")
                .and_then(Value::as_f64)
                .or_else(|| data.get("cost").and_then(Value::as_f64));
            self.subagents_cost_usd = None;
        }
        self.dirty = true;
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
                    rest: Map::default(),
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
                rest: Map::default(),
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
                rest: Map::default(),
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

    /// Send a prompt to the session and start the working loader. Session
    /// commands travel the same path — the session engine parses and
    /// executes them instead of admitting a model turn. `behavior` is the
    /// TS streaming behavior: Enter parks mid-turn input on the steering
    /// lane, the follow-up key on the follow-up lane; an idle session runs
    /// either immediately. The images whose markers are present in
    /// `text`, or `None` when there are none (TS `collectImagesFor`):
    /// attachments always reach the session - a text-only session model is
    /// either routed to `settings.imageModel` at dispatch or the turn
    /// fails there with the actionable setup error, so nothing is
    /// silently downgraded downstream.
    fn collect_images_for(&self, text: &str, _view: &AgentView) -> Option<serde_json::Value> {
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
    /// Slash-command dispatch (the TS interactive submission ladder reduced
    /// to this client's surface): local client commands run here, builtin
    /// client commands without a UI yet report unavailability, session
    /// commands (`compact`/`refine`/`goal`/`autonomous`) forward to the
    /// session, and unknown commands get the TS suggestion error — anything
    /// without a suggestion passes through as a prompt.
    ///
    /// `behavior` is TS `onSubmit`'s captured `streamingBehavior`: the
    /// submit lane that carried the text (alt+enter = followUp), passed
    /// through to every fallthrough prompt — TS sends the fallthrough with
    /// the submit's own lane, so a slash-prefixed follow-up keeps parking
    /// on the follow-up lane (Bugbot's lost-lane finding).
    async fn handle_slash(
        &mut self,
        text: &str,
        behavior: SubmitBehavior,
        view: &mut AgentView,
    ) -> Result<()> {
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
                return self.send_prompt(text, behavior, view).await;
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
                None => self.send_prompt(text, behavior, view).await,
            };
        };

        let command = registry
            .get(resolved.name)
            .expect("resolved name is builtin");
        match command.execution {
            SlashCommandExecution::Session => self.send_prompt(text, behavior, view).await,
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
                self.attach_session(&id, DockFold::Fresh).await?;
                // The title's pair is session-scoped: fetch the new
                // session's stats before the rebuild copies them into
                // the chrome, or the rebind would ride the session being
                // left's own cost and subagent aggregate.
                self.refresh_stats().await;
                self.rebuild_view(view, RebuildKind::Rebind);
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
            // `/model` opens the model picker (menu-only: the TS
            // `handleModelCommand` inline-arg form — an exact match applies
            // directly, anything else prefills the search — is deliberately
            // removed; a partial + Tab opens the picker filtered instead,
            // and a submitted argument is the usage error).
            "model" => {
                self.track_command_used("model");
                if !resolved.args.trim().is_empty() {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /model (Tab filters the picker)", view);
                    return Ok(());
                }
                self.open_model_picker(view, "").await?;
                self.track_menu_opened("model", "command");
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
                if resolved.args.is_empty() {
                    self.track_command_used("tree");
                    self.open_tree_selector(view, None).await?;
                } else {
                    self.note("Usage: /tree", view);
                }
            }
            // `/fork` (TS `showUserMessageSelector`): fork from a user
            // message into a new session.
            "fork" => {
                if resolved.args.is_empty() {
                    self.track_command_used("fork");
                    self.open_fork_selector(view).await?;
                } else {
                    self.note("Usage: /fork", view);
                }
            }
            // `/clone` (TS `handleCloneCommand`): duplicate the session at
            // the current position.
            "clone" => {
                if resolved.args.is_empty() {
                    self.track_command_used("clone");
                    self.handle_clone_command(view).await?;
                } else {
                    self.note("Usage: /clone", view);
                }
            }
            // TS `handleCopyCommand`: the last assistant text (the
            // daemon `get_last_assistant_text` lookup) copied to the
            // clipboard (platform tools, OSC 52 fallback). An argument is
            // the usage error with the text kept in the editor.
            "copy" => {
                if resolved.args.is_empty() {
                    self.track_command_used("copy");
                    self.handle_copy_command(view).await?;
                } else {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /copy", view);
                }
            }
            // `/login` (TS `showConfigurationMenu("providers")`): the
            // providers selector this build ports of that tab (the full
            // configuration menu stays unported; the panel is the same
            // TS `OAuthSelectorComponent` the tab mounts).
            "login" => {
                if resolved.args.is_empty() {
                    self.track_command_used("login");
                    self.open_provider_auth(AuthSelectorKind::Login, view)
                        .await?;
                } else {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /login", view);
                }
            }
            // `/logout` (TS `showLogoutSelector`): the stored-credential
            // selector; an empty store answers the TS status directly.
            "logout" => {
                if resolved.args.is_empty() {
                    self.track_command_used("logout");
                    self.open_provider_auth(AuthSelectorKind::Logout, view)
                        .await?;
                } else {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /logout", view);
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
            // `/nightly [on|off|status]` (TS `interactive-mode.ts`
            // 5455-5484): status resolves the effective channel,
            // off/stable pins the settings channel to stable, and on (or
            // bare) hands a `--self --nightly` update to the same parked
            // plan `/update` builds (the update command owns the nightly
            // warning, the channel switch, and the relaunch).
            "nightly" => {
                self.track_command_used("nightly");
                let arg = resolved.args.trim().to_lowercase();
                if arg == "status" {
                    // The effective channel resolves through the
                    // client-settings seam (pa-tui cannot reach the
                    // update flow's resolver); a surface without the
                    // seam never claims a channel.
                    let Some(settings) = &self.client_settings else {
                        self.note("/nightly is not available in this client yet", view);
                        return Ok(());
                    };
                    let preferred = settings.update_channel();
                    let channel = settings.effective_update_channel(&view.chrome.version);
                    let source = if preferred.is_some() {
                        "set in settings"
                    } else {
                        "inferred from the running version"
                    };
                    self.note(
                        &format!(
                            "Updates follow the {channel} channel ({source}). v{} installed.",
                            view.chrome.version
                        ),
                        view,
                    );
                    return Ok(());
                }
                if arg == "off" || arg == "stable" {
                    // The pin persists through the client-settings seam; a
                    // surface without the seam never claims the pin (TS
                    // always has a settings manager, so the gate is this
                    // client's honesty guard).
                    let Some(settings) = &self.client_settings else {
                        self.note("/nightly is not available in this client yet", view);
                        return Ok(());
                    };
                    if let Err(error) = settings.set_update_channel("stable") {
                        self.error_row(&format!("{error:#}"), view);
                        return Ok(());
                    }
                    self.note(
                        "Updates now follow the stable channel. Run /update to install the latest stable release.",
                        view,
                    );
                    return Ok(());
                }
                if !arg.is_empty() && arg != "on" {
                    self.error_row("Usage: /nightly [on|off|status]", view);
                    return Ok(());
                }
                // TS guards on compacting/streaming/bash: `turn_active`
                // carries the streaming and compaction arms, and the
                // user-bash slot (`!` runs) is its own state — a relaunch
                // mid-run would interrupt either.
                if self.turn_active || self.user_bash_running || self.work_in_flight() {
                    self.note_as(
                        "Wait for the current work to finish before updating.",
                        StatusKind::Warning,
                        view,
                    );
                    return Ok(());
                }
                let plan = crate::update_command::parse_update_args(&[
                    "--self".to_string(),
                    "--nightly".to_string(),
                ]);
                view.editor.set_text("");
                self.pending_update = Some(plan);
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
                if !plan.includes_self && (self.turn_active || self.work_in_flight()) {
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
            // `/plugins [search]` (TS `handlePluginsCommand` ->
            // `showServiceCatalogPicker`): the external-services catalog
            // picker. This client folds the catalog into the `/mcp` view
            // (the same resolved `services` cards the daemon serves both
            // surfaces), so the command opens that view; an argument
            // prefills its search field like TS's initial search.
            "plugins" => {
                self.track_command_used("plugins");
                self.open_mcp_view("/plugins", view, "").await?;
                let search = resolved.args.trim();
                if !search.is_empty() {
                    if let Some(mcp) = view.mcp_view.as_mut() {
                        mcp.paste(search);
                    }
                }
            }
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
                if resolved.args.is_empty() {
                    self.track_command_used("share");
                    self.handle_share_command(view).await?;
                } else {
                    view.editor
                        .set_text(&format!("/{} {}", resolved.original_name, resolved.args));
                    self.error_row("Usage: /share", view);
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
                // The operator's 2026-09-26 directive: the full guide
                // renders as the read-only info panel instead of the
                // multi-screen markdown flood in the transcript (the
                // content itself is unchanged).
                self.open_info_panel(
                    view,
                    Some("Hotkeys".to_string()),
                    InfoContent::Markdown(crate::hotkeys::hotkeys_guide(view.editor.keybindings())),
                );
                self.track_menu_opened("hotkeys", "command");
            }

            // `/session` (TS `handleSessionCommand`): the daemon's
            // session stats as the `Session Info` rows — rendered in the
            // read-only info panel (the operator's 2026-09-26
            // directive), not as transcript rows.
            "session" => {
                self.track_command_used("session");
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /session", view);
                    return Ok(());
                }
                let stats = self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::GetSessionStats {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            rest: Map::default(),
                        },
                    )
                    .await;
                match stats {
                    Ok(stats) => {
                        let name = self.session_name.clone();
                        // The content's own `Session Info` header row is
                        // the panel's head (no title duplication).
                        self.open_info_panel(
                            view,
                            None,
                            InfoContent::Rows(info_commands::session_info_rows(
                                &stats,
                                name.as_deref(),
                            )),
                        );
                        self.track_menu_opened("session", "command");
                    }
                    Err(error) => {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            // `/context` and its `/usage` alias (TS
            // `handleContextCommand` over `formatContextTree`): the agent
            // tree with own token/cost columns and context utilization —
            // rendered in the scrollable read-only info panel (the
            // operator's 2026-09-26 directive), not as transcript rows.
            // The optional `all` argument is #2842's deliberate TS delta
            // (TS takes none): over the row budget the default view
            // collapses to the highest-usage agents plus a summary row
            // and the expand hint, and `all` renders the whole tree.
            "context" => {
                self.track_command_used("context");
                let scope = match resolved.args.as_str() {
                    "" => info_commands::ContextTreeScope::Collapsed,
                    "all" => info_commands::ContextTreeScope::EveryAgent,
                    _ => {
                        view.editor.set_text(text);
                        self.error_row("Usage: /context [all]", view);
                        return Ok(());
                    }
                };
                let tree = self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::GetContextTree {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            rest: Map::default(),
                        },
                    )
                    .await;
                match tree {
                    Ok(tree) => {
                        // TS render width: clamp(columns - 2, 60, 120).
                        let width = terminal_columns().saturating_sub(2).clamp(60, 120);
                        // The content's own `Context` header row is the
                        // panel's head (no title duplication).
                        self.open_info_panel(
                            view,
                            None,
                            InfoContent::Rows(info_commands::context_tree_rows(
                                &tree, width, scope,
                            )),
                        );
                        self.track_menu_opened("context", "command");
                    }
                    Err(error) => {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            // `/system-prompt` (TS `handleSystemPromptCommand`): the header
            // with the char count, then the exact assembled prompt — a
            // document of unbounded size, so it renders in the
            // scrollable read-only info panel (the operator's 2026-09-26
            // directive) instead of flooding the transcript.
            "system-prompt" => {
                self.track_command_used("system-prompt");
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /system-prompt", view);
                    return Ok(());
                }
                let prompt = self
                    .bounded_request(
                        Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                        DaemonCommand::GetSystemPrompt {
                            id: None,
                            active_session_id: self.active_session_id.clone(),
                            rest: Map::default(),
                        },
                    )
                    .await;
                match prompt {
                    Ok(data) => {
                        let prompt = data
                            .get("systemPrompt")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let mut rows = info_commands::system_prompt_header_rows(prompt);
                        rows.push(Vec::new());
                        rows.extend(info_commands::system_prompt_body_rows(prompt));
                        // The header row (`System Prompt (N chars)`) is
                        // the panel's head.
                        self.open_info_panel(view, None, InfoContent::Rows(rows));
                        self.track_menu_opened("system-prompt", "command");
                    }
                    Err(error) => {
                        self.error_row(&format!("{error:#}"), view);
                    }
                }
            }
            // `/logs` (TS `handleLogsCommand`): a client-side read of the
            // logs directory (the daemon writes it, this client lists
            // it), rendered in the read-only info panel (the operator's
            // 2026-09-26 directive).
            "logs" => {
                self.track_command_used("logs");
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /logs", view);
                    return Ok(());
                }
                let Some(agent_dir) = pa_types::platform::agent_dir() else {
                    self.error_row(
                        "home directory not found: set HOME (or USERPROFILE on Windows)",
                        view,
                    );
                    return Ok(());
                };
                // The content's own `Logs` header row is the panel's
                // head.
                self.open_info_panel(
                    view,
                    None,
                    InfoContent::Rows(info_commands::logs_rows(&agent_dir.join("logs"))),
                );
                self.track_menu_opened("logs", "command");
            }
            // `/changelog` (TS `handleChangelogCommand`): the shipped
            // CHANGELOG.md entries, newest first, in the read-only info
            // panel (the operator's 2026-09-26 directive; the TS accent
            // `What's New` title is the panel's title).
            "changelog" => {
                self.track_command_used("changelog");
                if !resolved.args.is_empty() {
                    view.editor.set_text(text);
                    self.error_row("Usage: /changelog", view);
                    return Ok(());
                }
                self.open_info_panel(
                    view,
                    Some("What's New".to_string()),
                    InfoContent::Markdown(info_commands::changelog_markdown(
                        &Self::changelog_path(),
                    )),
                );
                self.track_menu_opened("changelog", "command");
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
                            rest: Map::default(),
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
            // `/speed [on|off]` (TS `setSpeedDisplay`): toggle the footer
            // tok/sec readout for this session — the dim dock row with the
            // latest response's rate and the session average.
            "speed" => {
                self.track_command_used("speed");
                let arg = resolved.args.trim().to_lowercase();
                if !arg.is_empty() && arg != "on" && arg != "off" {
                    self.error_row("Usage: /speed [on|off]", view);
                    return Ok(());
                }
                let enable = match arg.as_str() {
                    "on" => true,
                    "off" => false,
                    _ => !self.speed_display_enabled,
                };
                self.set_speed_display(enable, view);
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
                if self.turn_active || view.working.is_some() || self.work_in_flight() {
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
                self.open_heartbeats_view(view);
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

    /// Whether a `/reload` is in flight (the run loop must not end before
    /// its outcome row lands).
    pub(crate) fn reload_pending(&self) -> bool {
        self.reload.is_some()
    }

    /// The TS `showError` row: `⚠ Error: <message>` in the error color.
    pub(crate) fn error_row(&mut self, message: &str, view: &mut AgentView) {
        view.push_entry(ChatEntry::Status {
            text: format!("\u{26a0} Error: {message}"),
            kind: StatusKind::Error,
        });
        self.dirty = true;
    }

    /// Whether the `/mcp` view parked an auth request for the loop to
    /// spawn (checked after each dispatched key).
    pub(crate) fn pending_mcp_auth(&self) -> bool {
        self.pending_mcp_auth.is_some()
    }

    /// Report a menu surface opening (`tui menu opened`, fire-and-forget
    /// like the other adoption seams): `menu` names the surface (`model`,
    /// `mcp`), `source` how it opened (`command`, `tab`).
    fn track_menu_opened(&self, menu: &'static str, source: &'static str) {
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.menu_opened(menu, source).await;
            });
        }
    }

    /// Fetch the session's slash-command catalog in the background (TS
    /// `refreshConnectionCatalog`'s `getCommands` arm, best-effort with a
    /// bounded wait like the heartbeat refresh): the response carries the
    /// `skill:` commands the autocomplete provider lists. A fetch races a
    /// rebind silently — the epoch drops the stale response at fold time.
    pub(crate) fn spawn_command_catalog_refresh(&mut self) {
        self.command_refresh_epoch += 1;
        let epoch = self.command_refresh_epoch;
        // TS's rebind completes only after the fresh catalog lands
        // (`refreshConnectionCatalog` is awaited before the provider
        // rebuild), so the menu never serves the previous session's
        // skills. The clear rides the same FIFO channel ahead of the
        // fetch's response (this send completes before the spawn below
        // runs), so the old rows drop immediately and the fresh fetch
        // repopulates — a rebind never offers stale cross-session
        // commands.
        let _ = self.command_updates.send(CommandCatalogUpdate {
            epoch,
            skill_commands: Vec::new(),
        });
        let updates = self.command_updates.clone();
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        tokio::spawn(async move {
            let request = DaemonCommand::GetCommands {
                id: None,
                active_session_id,
                rest: Map::default(),
            };
            let fetched = tokio::time::timeout(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                client.request_ok(request),
            )
            .await;
            let skill_commands = match fetched {
                Ok(Ok(data)) => crate::autocomplete::skill_command_entries(&data),
                // TS `refreshCommandCatalogForCurrentSession` clears the
                // catalog on failure (`connectionCommands = []`); the
                // attach-time fetch keeps nothing either.
                Ok(Err(_)) | Err(_) => Vec::new(),
            };
            let _ = updates.send(CommandCatalogUpdate {
                epoch,
                skill_commands,
            });
        });
    }

    /// Fold a landed command-catalog refresh into the session (TS
    /// `refreshConnectionCatalog` -> `setupAutocompleteProvider`): the
    /// `skill:` commands replace the provider's list — gated by the
    /// `enableSkillCommands` setting (TS default true) — and a stale
    /// epoch never applies.
    pub(crate) fn apply_command_catalog(
        &mut self,
        update: CommandCatalogUpdate,
        view: &mut AgentView,
    ) {
        if update.epoch < self.command_refresh_epoch {
            return;
        }
        // The cache keeps the raw fetch (the toggle re-applies it under
        // the setting's new value); the setting gates only what the
        // provider lists. The TS default (true) applies when the
        // composition root supplies no settings seam.
        self.skill_commands_cache = update.skill_commands;
        let skills = if self
            .client_settings
            .as_ref()
            .is_none_or(|settings| settings.enable_skill_commands())
        {
            self.skill_commands_cache.clone()
        } else {
            Vec::new()
        };
        view.editor.set_autocomplete_skill_commands(skills);
        self.dirty = true;
    }

    /// The session's connection state (TS `AgentConnectionState`): the
    /// worker's `get_connection_state` response, which carries the
    /// connection fields (`availableThinkingLevels`, `thinkingLevel`,
    /// `steeringMode`, `serviceTier`, ...) — `get_state` serves the
    /// roster summary instead. `None` surfaces the failure as a note;
    /// callers keep the transcript unchanged then.
    async fn connection_state(&mut self, view: &mut AgentView) -> Option<Value> {
        match self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetConnectionState {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    rest: Map::default(),
                },
            )
            .await
        {
            Ok(data) => {
                // The queue delivery mode rides the state (TS
                // `steeringMode`): cached here — every state read is the
                // single refresh seam — so the queued-input adoption
                // event reports the live mode without a fetch.
                if let Some(mode) = data.get("steeringMode").and_then(Value::as_str) {
                    self.steering_mode = mode.to_string();
                }
                Some(data)
            }
            Err(error) => {
                self.note(&format!("{error:#}"), view);
                None
            }
        }
    }

    /// The `tui exit` reason recorded at the point the loop stopped.
    pub(crate) fn exit_reason(&self) -> &'static str {
        self.exit_reason
    }
}

/// Send a `create` command and return the new session's active id. A
/// non-empty selection picks the reopen form: `continueRecent` or an
/// explicit saved-session path.
async fn create_session(
    client: &DaemonClient,
    options: &InteractiveOptions,
    selection: Option<&SessionSelection>,
) -> Result<String> {
    let session_path = match selection {
        Some(SessionSelection::Resume(path)) => Some(path.to_string_lossy().to_string()),
        _ => None,
    };
    // The create consumes the path; a refusal needs it again for the
    // descriptive error.
    let refused_path = session_path.clone();
    let data = match client
        .request_ok(DaemonCommand::Create {
            id: None,
            session_path,
            // A create names its session (`sessionPath`) or opens one
            // through the agents view; `continueRecent` stays absent
            // (TS wire shape — the supervisor refuses it).
            continue_recent: None,
            no_session: options.no_session.then_some(true),
            name: None,
            config: Some(options.create_config()),
            telemetry_disabled: options.telemetry_disabled.filter(|disabled| *disabled),
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: Map::default(),
        })
        .await
    {
        Ok(data) => data,
        Err(error) => {
            return Err(describe_session_open_failure(client, error, refused_path).await);
        }
    };
    data.get("activeSessionId")
        .or_else(|| data.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("the daemon did not report a session id for the new session"))
}

/// A create refusal for a session file another holder already owns
/// names the holder and the next steps (the operator-directed
/// descriptive session-open error) instead of stopping at the bare
/// lease id. Any other failure propagates unchanged.
async fn describe_session_open_failure(
    client: &DaemonClient,
    error: anyhow::Error,
    session_path: Option<String>,
) -> anyhow::Error {
    // Only a typed daemon rejection decorates (transport failures pass
    // through unchanged), and the RAW rejection message is what gets
    // decorated — the typed wrapper's own display adds the framing
    // prefix exactly once.
    let Some((rejected, error_info)) = error
        .downcast_ref::<crate::daemon_client::RequestRejected>()
        .map(|rejected| (rejected.message.clone(), rejected.error_info.clone()))
    else {
        return error;
    };
    let Some(owner) = crate::session_open_error::owner_from_refusal(&rejected) else {
        return error;
    };
    let Some(path) = session_path.map(std::path::PathBuf::from) else {
        return error;
    };
    // The live-roster probe is best-effort and BOUNDED: a stalled `list`
    // must not hold the refusal for the daemon's full request timeout —
    // the startup hands off to the agents view promptly either way.
    let rows: Vec<Value> = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        client.request_ok(DaemonCommand::List {
            id: None,
            all: None,
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: Map::default(),
        }),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .map(|data| crate::session_open_error::roster_rows(&data).to_vec())
    .unwrap_or_default();
    // The path-keyed lookup first; the refusal's own holder id is the
    // fallback (a relative resume path can miss the canonical row).
    let holder = crate::session_open_error::holder_from_roster(&rows, &path)
        .or_else(|| crate::session_open_error::holder_by_id(&rows, &owner));
    // The daemon's ORIGINAL refusal line stays verbatim (never
    // reconstructed from a possibly-relative caller path) and the holder
    // guidance rides the same line — the agents-view handoff renders the
    // notice on a single status line, so a multiline decoration would
    // hide the holder and the next steps.
    let message =
        crate::session_open_error::decorate_interactive_refusal(&rejected, holder, &owner);
    // The refusal stays a typed `RequestRejected`: `is_daemon_rejection`
    // keeps classifying it (the interactive open hands off to the agents
    // view with the notice instead of exiting the client).
    anyhow::Error::new(crate::daemon_client::RequestRejected {
        command: "create".to_string(),
        message,
        // The typed refusal info rides the decorated refusal unchanged
        // (an `update_restarting` create refusal never reaches this
        // decorator: `owner_from_refusal` passes it through untouched).
        error_info,
    })
}
