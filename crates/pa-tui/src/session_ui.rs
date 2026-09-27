//! Live per-session UI state for the interactive loop: the daemon-client
//! side of one attached session — prompt submission, slash commands, streamed
//! event application, and session switching. Rendering itself lives in the
//! view crate modules; this module only decides what the view shows.

mod auth;
mod bash;
mod heartbeats;
mod model_picker;
mod queue;
mod settings;
mod stream;

use auth::{McpAuthIntent, PendingModelSignIn, SetModelOutcome};
pub(crate) use bash::BashActivityUpdate;
use bash::{ResyncBash, SideBashRun};
use heartbeats::paused_heartbeat_count;
pub(crate) use heartbeats::HeartbeatsUpdate;
pub(crate) use model_picker::picker_viewport_rows;
pub(crate) use model_picker::ModelCatalogUpdate;
use settings::PendingConfirm;
pub(crate) use settings::ReloadNote;
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

/// Cap on the detach request during the exit path: the client must exit
/// promptly even when the worker socket is wedged.
const EXIT_DETACH_TIMEOUT_MS: u64 = 600;
/// The double-Escape repeat window (TS `ESCAPE_REPEAT_WINDOW_MS`).
const ESCAPE_REPEAT_WINDOW_MS: std::time::Duration = std::time::Duration::from_millis(500);
/// Cap on the exit-path session-stats fetch (TS `formatResumeHint` inputs):
/// best-effort like the detach, never able to hold the exit open.
const EXIT_STATS_TIMEOUT_MS: u64 = 500;

/// TS `ANTHROPIC_SUBSCRIPTION_AUTH_WARNING` (auth-flows.ts, #2645): the
/// ban-risk warning a completed Anthropic subscription login shows once
/// per session (the settings toggle `warnings.anthropicExtraUsage`
/// gates it).
const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING: &str = "Anthropic subscription auth is active. Usage draws from your plan limits, but Prime Agent identifies as Claude Code and this may violate Anthropic's terms — your account can be restricted or banned. An Anthropic API key avoids the risk. Manage usage at https://claude.ai/settings/usage.";

/// How a submitted prompt travels to the session (TS `streamingBehavior`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubmitBehavior {
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

/// The `/traces upload-all` sweep's reports: the live progress counter and
/// the settled summary (TS `onProgress`'s status row + the arm's awaited
/// result).
pub(crate) type TracesUploadNote = crate::traces::TraceUploadAllNote;

/// One backgrounded prompt round trip's settled outcome (TS `onSubmit`
/// awaits `agentConnection.prompt` off the render path —
/// `interactive-mode.ts` clears the editor and lets Ink paint before the
/// await, and the daemon answer folds back later): `Ok(())` is an
/// admitted/queued prompt; the error is the daemon failure the inline
/// await used to surface on the key path.
pub(crate) struct PromptSubmitNote {
    /// The submit-time active id: the outcome applies only while the
    /// client still holds that session (a switch, a supersede rebind, or
    /// a `/new` replaced it) — TS's staleness guard for a submit that
    /// outlived its session.
    pub(crate) active_session_id: String,
    /// The submit-time durable session id: a stale FAILURE retains its
    /// rejected draft into THAT session's stash (TS `retainSubmittedDraft`
    /// targets the submit-time `submissionStashState`), never the newly
    /// mounted session's.
    pub(crate) session_id: String,
    /// The submitted text (the draft restore and the rebind replay).
    pub(crate) text: String,
    /// The submit lane (the queued-input telemetry and the rebind replay).
    pub(crate) behavior: SubmitBehavior,
    /// The collected prompt images (the rebind replay sends the same set).
    pub(crate) images: Option<serde_json::Value>,
    /// The submit-time image snapshot behind the submitted text's markers
    /// (TS `snapshotPromptStash` at submit): the refusal's retention keeps
    /// the attachments rehydratable even after the editor cleared and the
    /// registry could evict them.
    pub(crate) stashed_images: Vec<(u64, LoadedImage)>,
    /// Whether the turn was already active at submit time (the
    /// queued-input telemetry's lane gate; the inline path read the same
    /// flag after its await, which nothing could move while the loop was
    /// blocked).
    pub(crate) turn_was_active: bool,
    /// The expected end of this admitted prompt in submit order.
    pub(crate) expected_turn_end: u64,
    /// The submit's generation (TS `inputSubmissionGeneration`): a newer
    /// submit supersedes an older one's draft-restore right.
    pub(crate) generation: u64,
    /// Whether a failure may still rebind once (the replayed request is
    /// the second and last attempt — the inline path's
    /// `rebind_available`).
    pub(crate) rebind_available: bool,
    /// The settled request: admitted/queued on `Ok`; the daemon error
    /// otherwise.
    pub(crate) result: Result<(), anyhow::Error>,
}

/// One queued prompt round trip for the submit worker (the ordered channel
/// that replaces per-submit spawns): the worker drains its inbox one
/// request at a time, so the wire write for submit N+1 only happens after
/// submit N's round trip settles — cross-submit order is guaranteed on
/// the terminal path exactly like the blocked loop and TS's single-threaded
/// event loop guaranteed it (a per-submit `tokio::spawn` would schedule
/// the writes independently and could reorder two rapid submits).
pub(crate) struct PromptOrder {
    /// The connection the request travels on (captured per submit: the
    /// reconnect driver can replace the client between submits, and a
    /// long-lived worker must never hold the superseded connection).
    pub(crate) client: DaemonClient,
    pub(crate) active_session_id: String,
    pub(crate) session_id: String,
    pub(crate) text: String,
    pub(crate) behavior: SubmitBehavior,
    pub(crate) images: Option<serde_json::Value>,
    pub(crate) stashed_images: Vec<(u64, LoadedImage)>,
    pub(crate) turn_was_active: bool,
    pub(crate) expected_turn_end: u64,
    pub(crate) generation: u64,
    pub(crate) rebind_available: bool,
}

/// One backgrounded compaction-abort outcome (the abort supervision's UI
/// recovery): a failed abort request surfaces as the transcript note and
/// clears the stuck compaction loader locally — when even the abort could
/// not reach the daemon, the loader must not hang waiting for a
/// `compaction_end` that will never come. The session id keeps a stale
/// outcome from touching another session after `/switch` or `/new`.
pub(crate) struct CompactionAbortNote {
    pub(crate) active_session_id: String,
    /// The loader generation the abort addressed: an outcome applies only
    /// to the exact `compaction_start` that was on screen when the abort
    /// was sent — a newer run's loader is never cleared by a stale one.
    pub(crate) compaction_generation: u64,
    pub(crate) outcome: Result<(), String>,
}

pub(crate) struct ActivityUpdates {
    pub heartbeats: mpsc::UnboundedSender<HeartbeatsUpdate>,
    pub bash: mpsc::UnboundedSender<BashActivityUpdate>,
    pub commands: mpsc::UnboundedSender<CommandCatalogUpdate>,
}

/// A landed `get_commands` refresh (TS `refreshCommandCatalogForCurrentSession`
/// over `connectionCommands`): the session's `skill:` commands for the
/// autocomplete provider. A response from an older refresh (a rebind raced
/// a fetch) never applies — the epoch drops it.
pub(crate) struct CommandCatalogUpdate {
    pub epoch: u64,
    pub skill_commands: Vec<crate::autocomplete::SlashCommandEntry>,
}

/// A `/share` upload in flight: the abortable task and the temp export.
pub(crate) struct ShareRun {
    /// The upload task; aborting it kills `gh` (`kill_on_drop`).
    task: tokio::task::JoinHandle<()>,
    /// The temp HTML export `gh gist create` uploads (removed on settle).
    tmp_file: std::path::PathBuf,
}

/// A `/traces upload-all` run in flight (TS the arm's
/// `traceUploadAllAbortController` + the awaited sweep).
struct TraceUploadAllRun {
    /// The sweep task; aborting it drops the engine's requests mid-flight
    /// (the engine's own cancel keeps the sleeps and workers bounded).
    task: tokio::task::JoinHandle<()>,
    /// The cancel handle the clear key fires (TS `app.clear` → abort).
    cancel: crate::traces::TraceUploadCancel,
}

/// Why the parked traces login runs: the `login` arm, or the `on` arm's
/// credential-less entry (TS `handleTracesCommand` runs the login flow
/// inline, then continues the enable).
enum TracesLoginIntent {
    Login,
    Enable,
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
        // The turn-end watermark restarts with the stream: the ends this
        // attach will see belong to the newly mounted session, and an end
        // owed by the previous stream (a turn whose submit outlived the
        // switch — the daemon keeps running it for the detached session,
        // and its end never arrives on this stream) must not pin the
        // watermark. Without the reset a later prompt's ack would re-arm
        // `turn_active` against an end count that can never catch up, and
        // the idle gates would wait for an end that will never come (the
        // submit-outlived wedge: a turn never "settles" and the run
        // parks). The mounted snapshot's `streaming` flag carries the
        // live-turn state across the attach instead.
        self.turn_ends_seen = 0;
        self.last_prompt_turn_end = 0;
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

    /// Subscribe this client to the live agent roster (TS
    /// `subscribeAgentRoster`): the snapshot seeds the subagent summary
    /// counts, `roster_update` pushes keep them live. A failed
    /// subscription degrades to no counts (TS `rosterBar = undefined`).
    async fn subscribe_roster(&mut self) {
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

    /// Refresh the one-line activity dock from the existing session feeds.
    fn update_subagent_summary(&mut self, view: &mut AgentView) {
        let identity = crate::subagents::SessionIdentity::new(
            (!self.active_session_id.is_empty()).then(|| self.active_session_id.clone()),
            (!self.session_id.is_empty()).then(|| self.session_id.clone()),
            self.session_file.clone(),
        );
        self.subagent_counts = crate::subagents::count_descendants(&self.roster, &identity);
        let dock = self.activity_dock_state();
        // A scope-back reopen hands the dock back its focus exactly once,
        // at the FIRST summary after the attach: the roster is seeded by
        // then, so the Subagents group rides the rendered row at its
        // first paint (the operator's 2026-09-26 panel-exit ruling:
        // leaving the dock's Subagents panel lands on its own dock item,
        // not the prompt bar) — and a dock that never mounts keeps the
        // editor's focus; the one-shot means a LATE roster never yanks
        // the keyboard back mid-composition.
        if self.pending_dock_focus_restore {
            self.pending_dock_focus_restore = false;
            self.subagents_focused = dock.visible();
        }
        // A focused selection must stay on a rendered group: the arrows
        // visit every group an empty one included, so the selection
        // only moves when its group leaves the row (the goal row ends
        // with the goal) — and a dock that unmounts entirely (nothing
        // left to show) returns the focus to the editor.
        if self.subagents_focused {
            if !dock.visible() {
                self.subagents_focused = false;
            } else if !dock.groups().contains(&self.activity_group) {
                self.activity_group =
                    dock.step(self.activity_group, crate::chrome::ActivityDirection::Prev);
            }
        }
        view.chrome.activity = dock.visible().then_some(crate::chrome::ActivityDock {
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
    fn activity_dock_state(&self) -> crate::chrome::ActivityDock {
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
        // are separate and never appear here. The total keeps the dock
        // (and the bash view's history) mounted when no run is live.
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
            subagents_total: self.subagent_counts.total,
            heartbeats: self.heartbeat_catalog.len(),
            heartbeats_paused: paused_heartbeat_count(&self.heartbeat_catalog),
            bash_running,
            bash_total: bash_rows.len(),
            goal_label,
            selected: self.activity_group,
            focused: self.subagents_focused,
        }
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

    /// The editor's Down and Alt+A hand focus to the compact dock.
    fn focus_subagents_summary(&mut self, source: DockFocusSource, view: &mut AgentView) -> bool {
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
            DockFocusSource::Shortcut => return self.focus_activity_dock(view),
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
    /// a turn is active queue on the daemon side. `behavior` selects the
    /// lane (TS `handleFollowUp` routes the follow-up key through this
    /// same ladder with the `followUp` behavior).
    pub(crate) async fn submit_prompt(
        &mut self,
        text: &str,
        behavior: SubmitBehavior,
        view: &mut AgentView,
    ) -> Result<()> {
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
            return self.handle_slash(text, behavior, view).await;
        }
        self.send_prompt(text, behavior, view).await
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
                    rest: Map::default(),
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
                            rest: Map::default(),
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
        let id = event
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let status = event
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if self.active_side_question_id.as_deref() == Some(id.as_str()) && status != "running" {
            self.active_side_question_id = None;
        }
        let Some(pane) = view.side_pane.as_mut() else {
            return;
        };
        // TS `handleSideQuestionEvent` gates the render update on the tracked
        // turn (`event.id !== this.sideQuestionEvent?.id` returns early): the
        // tracked turn is the latest one the daemon started (client-local
        // notices never join it), so a late terminal event for a run whose
        // turn was closed (esc mid-run) cannot ghost into a newer pane as a
        // second turn.
        let tracked = pane
            .turns
            .iter()
            .rev()
            .find(|turn| !turn.local)
            .map(|turn| turn.id.as_str());
        if tracked != Some(id.as_str()) {
            return;
        }
        pane.upsert(crate::side_question::SideQuestionTurn {
            id,
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

    async fn send_prompt(
        &mut self,
        text: &str,
        behavior: SubmitBehavior,
        view: &mut AgentView,
    ) -> Result<()> {
        // A new prompt settles the held bash cards into the transcript
        // first (TS `onSubmit` flushes `pendingBashComponents` before the
        // prompt travels).
        self.flush_pending_bash(view);
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
        // TS `onSubmit` resolves the submit off the render path: the
        // cleared editor paints THIS iteration's frame — the submit's
        // daemon round trip never gates the first frame after Enter — and
        // the request settles in the background, its outcome folding back
        // through [`Self::apply_prompt_outcome`] with the same
        // bookkeeping and error ladder the inline await ran on the key
        // path.
        // TS snapshots the submitted draft (with its image markers) at
        // submit (`snapshotPromptStash`): the refusal's retention keeps
        // the attachments rehydratable even after the editor cleared and
        // a later paste-heavy submit could evict them from the registry.
        let stashed_images: Vec<(u64, LoadedImage)> =
            collect_marked_images(&self.pasted_images, text)
                .into_iter()
                .map(|(id, image)| (id, image.clone()))
                .collect();
        self.input_submission_generation += 1;
        let generation = self.input_submission_generation;
        self.order_prompt_request(
            text.to_string(),
            behavior,
            images,
            stashed_images,
            true,
            generation,
        );
        self.dirty = true;
        Ok(())
    }

    /// Queue one prompt round trip on the ordered submit channel (TS
    /// `onSubmit`'s `agentConnection.prompt` await runs off the render
    /// path): the request carries the same envelope the inline await
    /// sent, and the single worker (see [`PromptOrder`]) settles them
    /// strictly in submit order — the frame after Enter paints without
    /// gating on the daemon, and cross-submit wire order never depends on
    /// task scheduling. `rebind_available` is the inline path's
    /// one-rebind budget: the first attempt may re-attach and replay on
    /// the unknown-session refusal, a replay may not rebind again (the
    /// replay is the second and last attempt).
    fn order_prompt_request(
        &mut self,
        text: String,
        behavior: SubmitBehavior,
        images: Option<serde_json::Value>,
        stashed_images: Vec<(u64, LoadedImage)>,
        rebind_available: bool,
        generation: u64,
    ) {
        // The queued-input telemetry gates on the turn state at submit
        // time (the inline path read the same flag right after its
        // await, with the loop blocked so no event could move it); an
        // earlier submit still in flight held `turn_active` true on the
        // inline path too, so it counts here.
        let turn_was_active = self.turn_active || self.prompt_in_flight > 0;
        let expected_turn_end = self.last_prompt_turn_end.max(self.turn_ends_seen) + 1;
        self.last_prompt_turn_end = expected_turn_end;
        self.prompt_in_flight += 1;
        let _ = self.prompt_orders.send(PromptOrder {
            client: self.client.clone(),
            active_session_id: self.active_session_id.clone(),
            session_id: self.session_id.clone(),
            text,
            behavior,
            images,
            stashed_images,
            turn_was_active,
            expected_turn_end,
            generation,
            rebind_available,
        });
    }

    /// The single prompt-submit worker (the ordered channel's drain side):
    /// one request in flight at a time, submit N+1's wire write only after
    /// submit N's round trip settles. TS's single-threaded event loop
    /// serializes its submit writes the same way — the async handler's
    /// `await` never reorders two submissions (interactive-mode.ts's
    /// `handleSubmit`), and the port's old blocked loop enforced the same
    /// order by construction. The outcome folds back through the
    /// prompt-submit channel; the worker exits when the orders channel
    /// closes (the session dropped its sender).
    async fn prompt_submit_worker(
        mut orders: mpsc::UnboundedReceiver<PromptOrder>,
        notes: mpsc::UnboundedSender<PromptSubmitNote>,
    ) {
        while let Some(order) = orders.recv().await {
            let command = DaemonCommand::Prompt {
                id: None,
                active_session_id: order.active_session_id.clone(),
                message: order.text.clone(),
                input: pa_types::daemon::PromptInput {
                    content: None,
                    images: order.images.clone(),
                    streaming_behavior: Some(match order.behavior {
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
                    rlm_notice_nonce: None,
                },
                rest: Map::default(),
            };
            let result = tokio::time::timeout(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                order.client.request_ok(command),
            )
            .await
            .map_err(|_| {
                anyhow!(
                    "timed out after {UI_REQUEST_TIMEOUT_MS}ms waiting for the Prime Agent daemon response"
                )
            })
            .and_then(|result| result.map(|_| ()));
            let _ = notes.send(PromptSubmitNote {
                active_session_id: order.active_session_id,
                session_id: order.session_id,
                text: order.text,
                behavior: order.behavior,
                images: order.images,
                stashed_images: order.stashed_images,
                turn_was_active: order.turn_was_active,
                expected_turn_end: order.expected_turn_end,
                generation: order.generation,
                rebind_available: order.rebind_available,
                result,
            });
        }
    }

    /// How many prompt round trips are armed (see
    /// [`Self::prompt_in_flight`]): the headless idle and exit gates read
    /// it so a submit whose ack has not landed never reads as idle.
    pub(crate) fn prompt_submits_in_flight(&self) -> usize {
        self.prompt_in_flight
    }

    /// Whether user work is in flight for the busy guards (TS's
    /// `isStreaming`-gated commands — `/update`, `/nightly`, `/reload`):
    /// a live turn OR a prompt round trip still traveling. The inline
    /// submit held the guards by blocking until the ack set
    /// `turn_active`; the backgrounded submit makes that pre-ack window
    /// visible, and a package update or reload landing inside it would
    /// interrupt work the user just submitted, so the guards wait it out
    /// (the same class of busy the old blocked loop enforced).
    fn work_in_flight(&self) -> bool {
        self.prompt_in_flight > 0
    }

    /// Fold a backgrounded prompt outcome back into the session (the run
    /// loop's channel arm): the admission bookkeeping and the error
    /// ladder are the inline await's, moved off the key path — only the
    /// timing changed.
    pub(crate) async fn apply_prompt_outcome(
        &mut self,
        note: PromptSubmitNote,
        view: &mut AgentView,
    ) -> Result<()> {
        self.prompt_in_flight = self.prompt_in_flight.saturating_sub(1);
        // The submit's session is no longer the mounted one (a switch, a
        // supersede rebind, or a `/new` replaced it — TS's staleness
        // guard for a submit that outlived its session): the outcome
        // never applies bookkeeping to the new session, and never
        // restores a draft into another session's editor. A FAILED
        // outlived submit still shows its error row and retains its
        // rejected draft into the session it was typed for — TS
        // `handleSubmit`'s catch (interactive-mode.ts:5743 showError runs
        // regardless of the generation guard, and 5741 retains into the
        // submit-time stash state); a succeeded one stays silent (the
        // admitted turn belongs to the detached session, which the
        // daemon keeps serving).
        if note.active_session_id != self.active_session_id {
            // Borrow the settled result here: the ladder below owns it.
            if let Some(error) = note.result.as_ref().err() {
                let rendered = format!("{error:#}");
                self.error_row(&rendered, view);
                self.retain_rejected_draft(
                    &note.text,
                    &note.session_id,
                    note.generation,
                    note.stashed_images.clone(),
                    view,
                );
            }
            return Ok(());
        }
        match note.result {
            Ok(()) => {
                // A submission while a turn runs parks in the queue behind
                // it: the queue strip shows the message until the session
                // delivers it (adoption telemetry for the follow-up queue).
                if note.turn_was_active {
                    if let Some(telemetry) = self.telemetry.clone() {
                        let lane = match note.behavior {
                            SubmitBehavior::Steer => "steering",
                            SubmitBehavior::FollowUp => "follow_up",
                        };
                        // The queued-input adoption event carries the session's
                        // queue delivery mode (`tui input queued`'s
                        // `steering_mode`): exposure under batched delivery is
                        // the multi-steer batch feature's adoption signal.
                        let steering_mode = self.steering_mode.clone();
                        tokio::spawn(async move {
                            telemetry.queued_input(lane, steering_mode).await;
                        });
                    }
                }
                // The daemon can stream the complete turn before the ACK
                // reaches this channel. In that case turn_end already owns
                // the idle state; re-arming it would strand WaitIdle until
                // timeout. The per-submit end watermark also keeps a prior
                // turn's end from settling a queued later prompt.
                if self.turn_ends_seen < note.expected_turn_end {
                    self.turn_active = true;
                    self.start_loader(view);
                    self.dirty = true;
                }
                Ok(())
            }
            Err(error) => {
                let rendered = format!("{error:#}");
                // One rebind attempt per submit (never a loop): a prompt
                // refused with the unknown-session error - the held active
                // id was superseded by a worker replacement and the
                // supervisor could not rebind it either - re-attaches by
                // the DURABLE session id and replays the prompt ONCE.
                // The failed attempt never reached a worker (the
                // unknown-session refusal precedes any routing), so the
                // replay is exactly-once by construction.
                if note.rebind_available
                    && rendered.contains("Unknown active session")
                    && !self.session_id.is_empty()
                {
                    let durable = self.session_id.clone();
                    if self
                        .attach_session(&durable, DockFold::FirstFrame)
                        .await
                        .is_ok()
                    {
                        // The fresh attach snapshot owns the transcript;
                        // the replayed prompt renders on top of it. The
                        // replay keeps the submit's generation and spends
                        // the rebind budget.
                        self.rebuild_view(view, RebuildKind::Rebind);
                        self.order_prompt_request(
                            note.text.clone(),
                            note.behavior,
                            note.images.clone(),
                            note.stashed_images.clone(),
                            false,
                            note.generation,
                        );
                        return Ok(());
                    }
                }
                if crate::daemon_client::is_daemon_timeout(&error) {
                    // Sent but unanswered: the submission was on the
                    // wire, so the turn may already be admitted and
                    // running — restoring the draft would invite a
                    // duplicate submission. The error row names the
                    // uncertainty; the transcript's live turn (or the
                    // next daemon answer) settles the truth.
                    self.error_row(
                        &format!(
                            "{rendered} — the request was sent; the turn may still be in flight"
                        ),
                        view,
                    );
                    return Ok(());
                }
                // A DIRECT-link transport failure happened after the
                // frame was queued (`request_direct` sent it, the link
                // died answering): the daemon may have admitted the
                // turn — restoring the draft would invite a duplicate
                // submission, so the draft stays consumed (the timeout
                // arm's contract).
                let direct_sent = crate::daemon_client::is_daemon_unreachable(&error)
                    && rendered
                        .to_lowercase()
                        .contains("session connection closed");
                if direct_sent {
                    self.error_row(
                        &format!(
                            "{rendered} — the request may have been sent; the turn may still start"
                        ),
                        view,
                    );
                    return Ok(());
                }
                if crate::daemon_client::is_daemon_rejection(&error)
                    || crate::daemon_client::is_daemon_unreachable(&error)
                {
                    // TS `onSubmit`'s prompt catch: the daemon answered
                    // with a refusal for THIS request (admission, queue
                    // capacity, a superseded session the rebind could
                    // not recover), or the connection refused the send
                    // (nothing reached the daemon) — the `⚠ Error` row
                    // surfaces it and the draft returns to the editor
                    // (the submission never landed); a failed prompt
                    // never exits the UI (the reconnect driver owns
                    // the connection's recovery).
                    self.error_row(&rendered, view);
                    self.retain_rejected_draft(
                        &note.text,
                        &self.stash_session_id.clone(),
                        note.generation,
                        note.stashed_images.clone(),
                        view,
                    );
                    return Ok(());
                }
                Err(error)
            }
        }
    }

    /// Retain a refused prompt's draft (TS `onSubmit`'s catch ->
    /// `retainSubmittedDraft`, interactive-mode.ts:5741): the empty editor
    /// under the submit's own session and generation takes the text back
    /// into the editor; anything else — the user typed a fresh draft, a
    /// newer submit superseded this one, or the submit outlived its
    /// session — keeps the fresh text by retaining the rejected prompt as
    /// the session's restore-on-open head instead of clobbering it.
    fn retain_rejected_draft(
        &mut self,
        text: &str,
        stash_session_id: &str,
        generation: u64,
        stashed_images: Vec<(u64, LoadedImage)>,
        view: &mut AgentView,
    ) {
        if view.editor.get_text().trim().is_empty()
            && stash_session_id == self.stash_session_id
            && generation == self.input_submission_generation
        {
            view.editor.set_text(text);
            return;
        }
        // The retained-draft stash write: the rejected prompt becomes the
        // session's restore-on-open head with its submit-time image
        // snapshot (TS `snapshotPromptStash` at submit), so nothing the
        // user typed is lost and the draft returns the next time the
        // session opens with an empty editor (TS
        // `restorePromptStashIfEditorEmpty`).
        let stash = PromptStash {
            text: text.to_string(),
            paste_snapshot: None,
            images: stashed_images,
            restore_on_open: true,
        };
        let mut store = self
            .prompt_stash
            .lock()
            .expect("prompt stash store poisoned");
        store.for_session(stash_session_id).stash_draft_head(stash);
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
        // TS skips the relaunch when the interactive child exits with the
        // not-attempted code (75): a declined confirmation or a no-change
        // skip keeps the running client as-is, so the session is not torn
        // down and restarted for nothing.
        if matches!(child_result, Ok(75)) {
            return Ok(());
        }
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

    /// `/traces [status|on|off|preview|upload|upload-current|upload-all|
    /// login]` (TS `handleTracesCommand`): the status block, the
    /// enable/disable settings writes, the preview, the one-shot upload,
    /// the upload-all sweep, and the terminal login — the full TS command
    /// family over the composition root's trace engine.
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
        // TS reads the connection state for the session file (and the
        // upload-all sweep for the session dir).
        let state = self.connection_state(view).await;
        let state_field = |name: &str| {
            state
                .as_ref()
                .and_then(|state| state.get(name))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let session_file = state_field("sessionFile");
        let session_dir = state_field("sessionDir");
        match command.as_str() {
            "" | "status" => {
                // TS `settingsManager.reload()` then the block: the
                // fresh-manager reads are the reload's post-state.
                let enabled = traces.0.enabled().await;
                let credential = traces.0.credential().await;
                let rows = crate::traces::status_block(
                    enabled,
                    credential.as_deref(),
                    session_file.as_deref(),
                    &crate::traces::traces_base_url(),
                );
                // The info-display rows the `/session`-style commands
                // share — in the read-only info panel (the operator's
                // 2026-09-26 directive), never as transcript rows.
                self.open_info_panel(view, None, InfoContent::Rows(rows));
                self.track_menu_opened("traces", "command");
            }
            "off" | "disable" => {
                // TS `setAgentTracesEnabled(false)` + `flush()`, then the
                // status row.
                if let Err(error) = traces.0.set_enabled(false).await {
                    self.error_row(
                        &format!("Trace sharing disabled write failed: {error:#}"),
                        view,
                    );
                    return Ok(());
                }
                self.note("Trace sharing disabled.", view);
            }
            "on" | "enable" => {
                // TS the enable arm: a missing credential runs the login
                // flow first (the run loop parks it on the plain
                // terminal); a cancelled or failed login stops here.
                let credential = traces.0.credential().await;
                if credential.is_none() {
                    self.pending_traces_login = Some(TracesLoginIntent::Enable);
                    return Ok(());
                }
                self.enable_traces(&traces, session_file.as_deref(), view)
                    .await?;
            }
            "preview" => {
                // TS `previewCurrentTrace`: the block, or the fallback
                // status rows.
                match traces.0.preview(session_file.as_deref()).await {
                    crate::traces::TracePreviewOutcome::Ready(info) => {
                        let rows = crate::traces::preview_block(&info);
                        // The preview block's own `Trace Preview`
                        // header row is the panel's head.
                        self.open_info_panel(view, None, InfoContent::Rows(rows));
                        self.track_menu_opened("traces", "command");
                    }
                    crate::traces::TracePreviewOutcome::NoSessionFile => {
                        self.note(
                            "Trace preview is unavailable until the current session has a persisted assistant response.",
                            view,
                        );
                    }
                    crate::traces::TracePreviewOutcome::EmptySession => {
                        self.note("The current trace is empty.", view);
                    }
                    crate::traces::TracePreviewOutcome::Invalid { message }
                    | crate::traces::TracePreviewOutcome::Failed { message } => {
                        self.note(&format!("Trace preview failed: {message}."), view);
                    }
                }
            }
            "upload" | "upload-current" => {
                // TS the one-shot upload: the credential gate, then the
                // formatted row (a failure is the error row).
                let credential = traces.0.credential().await;
                if credential.is_none() {
                    self.error_row(
                        "Trace sharing needs a Prime API key. Run /traces login.",
                        view,
                    );
                    return Ok(());
                }
                let report = traces.0.upload_current(session_file.as_deref()).await;
                if report.status == crate::traces::TraceUploadStatus::Failed {
                    self.error_row(&report.text, view);
                } else {
                    self.note(&report.text, view);
                }
            }
            "upload-all" => {
                // TS the sweep: the credential gate, the one-sweep-at-a-
                // time guard, then the background run (progress through
                // the note channel, the clear key cancels).
                let credential = traces.0.credential().await;
                if credential.is_none() {
                    self.error_row(
                        "Trace sharing needs a Prime API key. Run /traces login.",
                        view,
                    );
                    return Ok(());
                }
                if self.trace_upload.is_some() {
                    self.note_as(
                        "A trace upload is already running. Cancel it before starting another.",
                        StatusKind::Warning,
                        view,
                    );
                    return Ok(());
                }
                let notes = self.traces_upload_notes.clone();
                let cancel = crate::traces::TraceUploadCancel::new();
                let run_cancel = cancel.clone();
                let handle = traces.clone();
                let task = tokio::spawn(async move {
                    let report = handle
                        .0
                        .upload_all(session_dir.as_deref(), notes.clone(), run_cancel.clone())
                        .await;
                    let _ = notes.send(crate::traces::TraceUploadAllNote::Done {
                        result: report,
                        cancelled: run_cancel.is_cancelled(),
                    });
                });
                self.trace_upload = Some(TraceUploadAllRun { task, cancel });
            }
            "login" => {
                // TS runs the login dialog; the terminal port parks the
                // flow against the inline auth panel (the run loop mounts
                // it right after this key).
                self.pending_traces_login = Some(TracesLoginIntent::Login);
            }
            _ => {
                self.note_as(
                    "Usage: /traces [status|on|off|preview|upload|upload-current|upload-all|login]",
                    StatusKind::Warning,
                    view,
                );
            }
        }
        Ok(())
    }

    /// TS the enable arm's tail (after the credential): set the flag,
    /// flush, then the one-shot upload whose message rides the status
    /// row.
    async fn enable_traces(
        &mut self,
        traces: &crate::traces::TracesCommandsHandle,
        session_file: Option<&str>,
        view: &mut AgentView,
    ) -> Result<()> {
        if let Err(error) = traces.0.set_enabled(true).await {
            self.error_row(
                &format!("Trace sharing enabled write failed: {error:#}"),
                view,
            );
            return Ok(());
        }
        let report = traces.0.upload_current(session_file).await;
        self.note(
            &format!("Trace sharing enabled. {}", report.enable_message()),
            view,
        );
        Ok(())
    }

    /// Whether a parked `/traces login` waits for the panel mount (the
    /// run loop checks this after each key).
    pub(crate) fn pending_traces_login(&self) -> bool {
        self.pending_traces_login.is_some()
    }

    /// The parked traces login: mount the inline auth panel (TS the
    /// login dialog mounts as the flow starts) and spawn the flow against
    /// it; the settled outcome folds in through the panel channel and
    /// continues the enable intent (TS's `on` arm).
    pub(crate) fn run_traces_login(&mut self, view: &mut AgentView) {
        // The park is consumed here (the intent moves to the in-flight
        // run): the key-path check spawns the flow exactly once.
        let Some(intent) = self.pending_traces_login.take() else {
            return;
        };
        let Some(traces) = self.traces.clone() else {
            return;
        };
        self.traces_login_run = Some(intent);
        self.traces_login_gen += 1;
        let gen = self.traces_login_gen;
        let panel = crate::auth_panel::AuthPanelHandle::new(self.auth_panel_notes.clone());
        let mut traces_dialog = crate::auth_panel::AuthPanel::new("Login to Prime Agent Traces");
        traces_dialog.set_cancel_signal(panel.cancel_signal());
        view.auth_panel = Some(traces_dialog);
        tokio::spawn(async move {
            let outcome = traces.0.login(panel.clone()).await;
            panel.send(crate::auth_panel::AuthPanelRequest::TracesSettled { outcome, gen });
        });
    }

    /// A settled traces login (the panel channel's `TracesSettled`): the
    /// outcome row lands, and the enable intent continues TS's `on` arm.
    async fn finish_traces_login(
        &mut self,
        outcome: crate::traces::TraceLoginOutcome,
        view: &mut AgentView,
    ) {
        let intent = self.traces_login_run.take();
        let Some(traces) = self.traces.clone() else {
            return;
        };
        match outcome {
            crate::traces::TraceLoginOutcome::Status(message) => {
                self.note(&message, view);
                if matches!(intent, Some(TracesLoginIntent::Enable)) {
                    // TS re-reads the credential after the login: still
                    // none is the TS error row; a resolved one continues
                    // the enable (set, flush, upload once).
                    let credential = traces.0.credential().await;
                    if credential.is_none() {
                        self.error_row("Trace sharing needs a Prime API key.", view);
                    } else {
                        let state = self.connection_state(view).await;
                        let session_file = state
                            .as_ref()
                            .and_then(|state| state.get("sessionFile"))
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if let Err(error) = self
                            .enable_traces(&traces, session_file.as_deref(), view)
                            .await
                        {
                            self.error_row(&format!("{error:#}"), view);
                        }
                    }
                }
            }
            crate::traces::TraceLoginOutcome::Error(message) => {
                self.error_row(&message, view);
            }
            // A cancelled login stays silent (TS the cancelled dialog
            // shows no row).
            crate::traces::TraceLoginOutcome::Cancelled => {}
        }
        self.dirty = true;
    }

    /// Whether a `/traces upload-all` sweep is in flight (the run loop
    /// must not end before its outcome row lands).
    pub(crate) fn traces_upload_pending(&self) -> bool {
        self.trace_upload.is_some()
    }

    /// One upload-all note (the run loop folds it in): the live counter
    /// rewrites the status row in place (TS `showStatus`), the settled
    /// run reports TS's summary (or the cancel row).
    pub(crate) fn apply_traces_upload_note(
        &mut self,
        note: crate::traces::TraceUploadAllNote,
        view: &mut AgentView,
    ) {
        match note {
            crate::traces::TraceUploadAllNote::Progress { completed, total } => {
                let key = view.editor.keybindings().key_text("app.clear");
                self.note(
                    &format!("Uploading traces: {completed}/{total} ({key} to cancel)"),
                    view,
                );
            }
            crate::traces::TraceUploadAllNote::Done { result, cancelled } => {
                // A late outcome after the run went away is ignored (the
                // sweep was superseded); the settled run's task is
                // reaped here.
                let Some(run) = self.trace_upload.take() else {
                    return;
                };
                // Aborting the task cancels the engine's sweep the same
                // way the handle does; the outcome note still folds in.
                run.task.abort();
                if cancelled {
                    self.note("Trace upload cancelled.", view);
                    return;
                }
                if result.total == 0 {
                    self.note("No persisted traces were found.", view);
                    return;
                }
                // TS's summary: the uploaded count, the optional skipped
                // and failed counts, then the stored bytes.
                let mut parts = vec![format!(
                    "Uploaded {} of {} traces",
                    crate::traces::thousands(result.uploaded as u64),
                    crate::traces::thousands(result.total as u64)
                )];
                if result.skipped > 0 {
                    parts.push(format!(
                        "{} skipped",
                        crate::traces::thousands(result.skipped as u64)
                    ));
                }
                if result.failed > 0 {
                    parts.push(format!(
                        "{} failed",
                        crate::traces::thousands(result.failed as u64)
                    ));
                }
                parts.push(format!(
                    "{} bytes stored",
                    crate::traces::thousands(result.bytes_stored)
                ));
                let summary = parts.join("; ");
                if result.failed > 0 {
                    self.note_as(
                        &format!("{summary}. See {} for details.", result.log_path),
                        StatusKind::Warning,
                        view,
                    );
                } else {
                    self.note(&format!("{summary}."), view);
                }
            }
        }
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
                    rest: Map::default(),
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
            Ok(()) => self.toast("Copied last agent message to clipboard", view),
            Err(message) => self.error_row(&message, view),
        }
        Ok(())
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
        let request = if output_path.as_deref().is_some_and(|path| {
            std::path::Path::new(path)
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
        }) {
            DaemonCommand::ExportJsonl {
                id: None,
                active_session_id: self.active_session_id.clone(),
                output_path,
                rest: Map::default(),
            }
        } else {
            DaemonCommand::ExportHtml {
                id: None,
                active_session_id: self.active_session_id.clone(),
                output_path,
                rest: Map::default(),
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
                    rest: Map::default(),
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
                    rest: Map::default(),
                },
            )
            .await?;
        if data
            .get("flatNodes")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
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
                    rest: Map::default(),
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
                    rest: Map::default(),
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
                    rest: Map::default(),
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
                    rest: Map::default(),
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
                    rest: Map::default(),
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
            restore_dock_focus: false,
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
                    rest: Map::default(),
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
        // The listing renders in the read-only info panel (the
        // operator's 2026-09-26 directive): it no longer lands in the
        // transcript as a multi-line status row. The row content is
        // unchanged — `/switch <n|id>` still resolves against the same
        // cached rows.
        let raw = |text: String| vec![info_commands::ClientSpan { text, color: None }];
        let mut rows = vec![raw("live sessions:".to_string())];
        if sessions.is_empty() {
            rows.push(raw("  (none)".to_string()));
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
            rows.push(raw(format!(
                "{current} {}. {name} ({id}) {activity} {cwd}",
                index + 1
            )));
        }
        rows.push(raw("switch with /switch <n|id>".to_string()));
        self.open_info_panel(view, Some("Sessions".to_string()), InfoContent::Rows(rows));
        self.track_menu_opened("list", "command");
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
        match self.attach_session(&id, DockFold::FirstFrame).await {
            Ok(()) => {
                // Session-scoped stats again: the rebuilt title must show
                // the switched-to session's pair, not the one being left.
                self.refresh_stats().await;
                self.rebuild_view(view, RebuildKind::Rebind);
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

    /// The armed hint's expiry instant while its window is still open
    /// (the render loop arms its deadline there so the expired hint
    /// repaints away, TS `showCtrlCExitHint`'s setTimeout +
    /// requestRender; without it the stale tray row survives until the
    /// next unrelated event).
    pub(crate) fn ctrl_c_hint_expiry(&self) -> Option<std::time::Instant> {
        self.ctrl_c_hint_until
            .filter(|until| std::time::Instant::now() < *until)
    }

    /// A mouse report (TS `handleFullscreenInput`'s mouse branches):
    /// wheel turns scroll the transcript window by three lines; a left
    /// press starts a selection (transcript, or the frame surface when the
    /// press is outside the window), a drag extends it with edge
    /// auto-scroll, and a release copies the spanned text out through OSC
    /// 52. A release without a drag opens the link under the press
    /// position (TS `fullscreenPressedHyperlink`: terminals gate native
    /// link handling while mouse reporting is active, so clicks the TUI
    /// consumes must open their OSC 8 targets themselves), and with no
    /// link there it fires the click target under the press (TS
    /// `dispatchFullscreenClick`, the `click_dispatch` module): cards and
    /// condensed run blocks cycle the conversation detail, the editor's
    /// content rows place the caret, and a picker's rows move its
    /// selection. Reports are consumed even while a picker, selector, or
    /// loader owns the frame (the TS overlay-focus gate) — the wheel
    /// never scrolls behind one, but its rows select; while tracking is
    /// inactive every report is consumed without a dispatch. The
    /// onboarding pane owns the frame the same way (TS's splash is a
    /// 100% overlay): its rows select as frame regions and its links
    /// open, but no transcript scrolls behind it.
    pub(crate) fn handle_mouse(&mut self, event: crate::mouse::MouseEvent, view: &mut AgentView) {
        if !crate::mouse_tracking::active() {
            return;
        }
        // TS `isFullscreenOverlayFocused`: the `/model` and `/effort`
        // pickers, the `/tree` and `/fork` selectors, the `/mcp`
        // connections view, the `/share` loader, and the onboarding splash
        // own the frame like the TS overlays.
        let overlay_focused = view.model_picker.is_some()
            || view.effort_picker.is_some()
            || view.heartbeats_picker.is_some()
            || view.goal_panel.is_some()
            || view.bash_view.is_some()
            || view.info_panel.is_some()
            || view.tree_selector.is_some()
            || view.fork_selector.is_some()
            || view.share_loader.is_some()
            || view.mcp_view.is_some()
            || view.onboarding.is_some();
        // TS records the press state before the dispatch: a drag report
        // marks the press, a plain press remembers the link under it.
        let left = event.button == crate::mouse::BUTTON_LEFT;
        let release_was_drag = left && !event.press && self.left_mouse_dragged;
        // Screen cells are one-based in the report (TS passes `event.y - 1`).
        let row = event.y.saturating_sub(1) as usize;
        let col = event.x.saturating_sub(1) as usize;
        if left && event.press {
            self.left_mouse_dragged = event.motion;
            if !event.motion {
                self.pressed_hyperlink = view.hyperlink_at(row, col);
            }
        }
        // Wheel turns scroll only on the session surface; a pane owns the
        // frame, the turn is consumed without scrolling.
        if let Some(delta) = crate::mouse::wheel_scroll_delta(&event) {
            if !overlay_focused {
                view.scroll_by(delta);
                self.dirty = true;
            }
            return;
        }
        // A buttonless motion report is the hover (operator directive
        // 2026-09-26: `?1003` any-event tracking delivers it): the
        // hovered clickable card row records its hover state, and the
        // frame re-renders only when that state changed — a motion burst
        // across one row never schedules a render per report.
        if event.button == crate::mouse::BUTTON_NONE && event.motion {
            if view.note_hover(row, col) {
                self.dirty = true;
            }
            return;
        }
        let left_press = event.press && left;
        let mut open_pressed_link = false;
        if overlay_focused {
            // TS tries the frame surface first while an overlay owns the
            // frame (its rows are the selectable spans), then the window.
            self.stop_selection_auto_scroll();
            if left_press && !event.motion {
                self.record_pressed_click(view, &event);
                if !view.begin_frame_selection(row, col) {
                    view.begin_selection(row, col);
                }
                self.dirty = true;
            } else if left_press && event.motion {
                self.left_mouse_dragged = true;
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
                open_pressed_link = left && !event.motion && !release_was_drag;
            }
        } else if left_press && !event.motion {
            self.stop_selection_auto_scroll();
            self.record_pressed_click(view, &event);
            // TS `beginSelection` then the `beginFrameSelection` fallback.
            if !view.begin_selection(row, col) {
                view.begin_frame_selection(row, col);
            }
            self.dirty = true;
        } else if left_press && event.motion {
            self.left_mouse_dragged = true;
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
            open_pressed_link = left && !event.motion && !release_was_drag;
        }
        // TS opens `fullscreenPressedHyperlink ?? hyperlinkAt(release)`
        // on a plain left release: the pressed position wins, and a
        // release over another link still opens that link (a plain click
        // moves no cells). With no link there, the release fires the
        // click target recorded at the press (TS `dispatchFullscreenClick`).
        if open_pressed_link {
            let url = self
                .pressed_hyperlink
                .take()
                .or_else(|| view.hyperlink_at(row, col));
            if let Some(url) = url {
                self.open_hyperlink(&url);
            } else if !event.shift && !event.alt && !event.ctrl {
                // TS gates the click dispatch on the release's
                // modifiers too: modified clicks stay selection-only.
                self.dispatch_plain_click(view, row);
            }
        }
        // TS clears the press state after every left release, so a later
        // release can never open a stale press — the click target rides
        // the same cleanup (a drag-selection release consumes nothing).
        if left && !event.press {
            self.left_mouse_dragged = false;
            self.pressed_hyperlink = None;
            self.pressed_click = None;
        }
    }

    /// Open one clicked link (TS `openHyperlink`): the href guard admits
    /// only web and file locations, then the platform opener launches it
    /// fire-and-forget. A headless run has no terminal — and no browser to
    /// hand one to — so it records the URL for its verifier instead.
    fn open_hyperlink(&mut self, url: &str) {
        let Some(href) = crate::hyperlinks::openable_href(url) else {
            return;
        };
        self.opened_urls.push(href.clone());
        if std::io::IsTerminal::is_terminal(&std::io::stdout()) {
            crate::browser::open_in_browser(&href);
        }
    }

    /// Copy a finished selection out (TS `copySelection` +
    /// `copyFullscreenSelection`): OSC 52 works locally, over SSH, and
    /// through tmux (`set-clipboard`), so the write goes straight to the
    /// terminal; a headless run has no terminal and records the text for
    /// its verifier instead. A successful copy surfaces the
    /// "Copied selection to clipboard" action toast (the ephemeral
    /// overlay, not the TS `showStatus` chat row — sanctioned divergence),
    /// a failed write the failure row (TS `showError`).
    fn copy_selection(&mut self, text: &str, view: &mut AgentView) {
        use base64::Engine;
        use std::io::Write;
        let lines = text.lines().count().max(1);
        self.copies.push(text.to_string());
        self.track_selection(lines);
        if !std::io::IsTerminal::is_terminal(&std::io::stdout()) {
            self.toast("Copied selection to clipboard", view);
            return;
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        let mut out = std::io::stdout();
        match out.write_all(format!("\x1b]52;c;{encoded}\x07").as_bytes()) {
            Ok(()) => {
                let _ = out.flush();
                self.toast("Copied selection to clipboard", view);
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
                    });
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
        // The bash view owns the whole frame while open (like its key
        // dispatch): a paste never lands in the hidden editor prompt,
        // where a later Enter would submit it unedited. The read-only
        // goal panel and info panel consume it the same way.
        if view.bash_view.is_some() || view.goal_panel.is_some() || view.info_panel.is_some() {
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
            Some(EffortPickerAction::None) | None => {}
            Some(EffortPickerAction::Cancel) => {
                view.effort_picker = None;
                self.dirty = true;
            }
            Some(EffortPickerAction::Apply { level }) => {
                view.effort_picker = None;
                self.apply_thinking_level(&level, view).await;
            }
        }
        Ok(())
    }

    fn emit_activity_opened(&self, kind: &'static str) {
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.activity_opened(kind).await;
            });
        }
    }

    /// The dock's Enter hand-off (the operator's direct-navigation
    /// redesign): the focused group opens its own view directly — the
    /// scoped agents view for subagents, the heartbeats view, or the
    /// bash view — with no intermediate grouped list.
    fn open_dock_group_view(&mut self, view: &mut AgentView) {
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
    fn open_info_panel(
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
    async fn handle_goal_panel_key(&mut self, key: KeyEvent, view: &mut AgentView) -> Result<()> {
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
    async fn handle_info_panel_key(&mut self, key: KeyEvent, view: &mut AgentView) -> Result<()> {
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

    /// Abort the active turn off the UI loop (TS `interruptOrClearInput`
    /// fires `void abortAndSendQueued()` when streaming, schema 29): the
    /// daemon aborts the run and the queue keeps flowing behind the
    /// settled turn — parked steering delivers as one batched turn, then
    /// the follow-up lane drains one turn per completed turn; a plain
    /// abort when the abort leaves nothing queued. A daemon without the
    /// schema-29 capability gets the plain abort (TS
    /// `supportsServerCapability` + the `isUnknownDaemonCommandError`
    /// catch, both arms of TS `abortAndSendQueued`). The request never
    /// blocks key handling, and a failure surfaces later as a transcript
    /// note.
    fn abort_turn(&self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let notes = self.notes.clone();
        tokio::spawn(async move {
            let mut result = if client.supports_server_capability("abort_and_send_queued") {
                client
                    .request_ok(DaemonCommand::AbortAndSendQueued {
                        id: None,
                        active_session_id: active_session_id.clone(),
                        rest: Map::default(),
                    })
                    .await
            } else {
                client
                    .request_ok(DaemonCommand::Abort {
                        id: None,
                        active_session_id: active_session_id.clone(),
                        rest: Map::default(),
                    })
                    .await
            };
            // A daemon that rejects the command itself gets the plain
            // abort too (TS `isUnknownDaemonCommandError`'s arm).
            if matches!(&result, Err(error) if error.to_string().contains("abort_and_send_queued"))
            {
                result = client
                    .request_ok(DaemonCommand::Abort {
                        id: None,
                        active_session_id,
                        rest: Map::default(),
                    })
                    .await;
            }
            if let Err(error) = result {
                let _ = notes.send(format!("the abort failed: {error:#}"));
            }
        });
    }

    /// Cancel the in-flight compaction off the UI loop (TS
    /// `interruptOrClearInput` fires `abortCompaction()` when the
    /// compaction loader is up — the agent is not streaming during a
    /// compaction, so the interrupt cancels the run, not a turn): the
    /// request never blocks key handling. A failure surfaces later as a
    /// transcript note and clears the stuck loader locally (the abort
    /// supervision's UI recovery): the daemon's own `compaction_end`
    /// normally clears it, but an abort that could not even reach the
    /// daemon must not leave the UI waiting on an end that never comes.
    fn abort_compaction(&self, compaction_generation: u64) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let abort_notes = self.compaction_abort_notes.clone();
        tokio::spawn(async move {
            // Via the supervisor even when a direct link serves the
            // session: the direct link IS the wedged worker in the case
            // the supervisor's abort arm exists for.
            let result = client
                .request_ok_via_supervisor(DaemonCommand::AbortCompaction {
                    id: None,
                    active_session_id: active_session_id.clone(),
                    rest: Map::default(),
                })
                .await;
            if let Err(error) = result {
                let _ = abort_notes.send(CompactionAbortNote {
                    active_session_id,
                    compaction_generation,
                    outcome: Err(format!("{error:#}")),
                });
            }
        });
    }

    /// Apply one backgrounded compaction-abort outcome: the failed note
    /// surfaces as a transcript row and the compaction loader clears —
    /// the local recovery when the abort never reached the daemon. An
    /// outcome from a session this UI no longer shows (`/switch`, `/new`
    /// mid-request), or addressed to a loader a newer `compaction_start`
    /// has since replaced, touches nothing.
    pub(crate) fn apply_compaction_abort_outcome(
        &mut self,
        note: CompactionAbortNote,
        view: &mut AgentView,
    ) {
        if note.active_session_id != self.active_session_id
            || note.compaction_generation != view.compaction_generation
        {
            return;
        }
        if let Err(error) = note.outcome {
            self.note(&format!("the compaction abort failed: {error:#}"), view);
            view.compaction = None;
        }
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
                    rest: Map::default(),
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

    /// The run's first click-driven interaction (`tui click used`,
    /// adoption; later clicks in the same run are not reported).
    pub(crate) fn track_click(&mut self, surface: &'static str) {
        if self.click_adoption_emitted {
            return;
        }
        self.click_adoption_emitted = true;
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.click_used(surface).await;
            });
        }
    }

    /// Take a pending `app.suspend` request (TS `handleCtrlZ`): the
    /// interactive loop performs the process-group suspend cycle; only
    /// the loop owns the renderer that hands the terminal over.
    pub(crate) fn take_suspend_request(&mut self) -> bool {
        std::mem::take(&mut self.suspend_requested)
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
        // The bash view owns the frame the same way.
        if view.bash_view.is_some() {
            return self.handle_bash_view_key(key, view).await;
        }
        // The read-only goal panel owns the frame the same way.
        if view.goal_panel.is_some() {
            return self.handle_goal_panel_key(key, view).await;
        }
        // The read-only info panel owns the frame the same way.
        if view.info_panel.is_some() {
            return self.handle_info_panel_key(key, view).await;
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
        // The inline auth panel owns the frame the same way (TS the login
        // dialog / team selector mounts over the prompt).
        if view.auth_panel.is_some() {
            return self.handle_auth_panel_key(key, view).await;
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
            // The viewport consumes the key before the editor, so the
            // editor's own page arms never run: collapse a selection
            // here or it survives the scroll as a stale replace range.
            view.editor.clear_selection();
            view.scroll_by(-(view.page_size() as isize));
            self.track_scroll("page_up", view.is_following());
            self.dirty = true;
            return Ok(());
        }
        if page_down {
            view.editor.clear_selection();
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
        // The activity dock owns focus while focused: Enter (and a second
        // Alt+A) opens the focused group's own view directly (the
        // operator's direct-navigation redesign), left/right step the
        // dock's groups, up/cancel/back returns to the editor, expand
        // cycles the conversation detail and KEEPS the focus, and every
        // other key falls through after releasing the focus (TS
        // `onChatAction` -> `focusEditor` -> the editor handles it).
        if self.subagents_focused {
            let kb = view.editor.keybindings();
            if kb.matches(&id, "tui.select.confirm") || kb.matches(&id, "app.subagents.focus") {
                // The dock is the direct launcher: Enter opens the
                // focused group's own view (the operator's redesign —
                // the grouped activity panel is gone).
                self.open_dock_group_view(view);
                return Ok(());
            }
            if id == "left" || id == "right" {
                // One press, one group: the step lands on the
                // neighboring rendered group and wraps at the row's
                // ends, so an empty group is still visited (the
                // operator's 2026-09-26 muscle-memory directive — an
                // empty group never skips) and N groups take N
                // presses to cycle.
                let direction = if id == "left" {
                    crate::chrome::ActivityDirection::Prev
                } else {
                    crate::chrome::ActivityDirection::Next
                };
                self.activity_group = self
                    .activity_dock_state()
                    .step(self.activity_group, direction);
                self.update_subagent_summary(view);
                self.dirty = true;
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
                self.save_chat_detail(view);
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
        if view.editor.keybindings().matches(&id, "app.input.clear") {
            // The completion surface consumes Esc: the open dropdown
            // closes, and a parked request (Tab before the input-idle
            // tick materializes it) cancels before it can open the menu —
            // either way the key stops there. The abort ladder (the
            // escape-repeat arming and `interrupt_running_work`) runs only
            // when no menu is open or about to open — closing a menu must
            // never abort a running turn (the TS base editor consumes
            // `tui.select.cancel` inside the dropdown; the TS
            // custom-editor overlay propagates Esc to the interrupt after
            // closing, the behavior this deliberately removes).
            if view.editor.is_showing_autocomplete() || view.editor.has_pending_autocomplete() {
                view.editor.cancel_autocomplete();
                self.clear_ctrl_c_hint();
                return Ok(());
            }
            // An active selection consumes the first Escape (standard
            // editors' drop-the-selection press): the interrupt/clear
            // ladder runs on the next press.
            if view.editor.has_selection() {
                view.editor.clear_selection();
                self.clear_ctrl_c_hint();
                self.dirty = true;
                return Ok(());
            }
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
            // TS `handleEscape` arms the repeat, then fires
            // `interruptOrClearInput()` — the same abort ladder as the
            // Ctrl+C interrupt, minus the Ctrl+C exit hint (TS shows that
            // only through `handleInterruptKey`).
            self.interrupt_running_work(view);
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
                            rest: Map::default(),
                        })
                        .await
                    {
                        let _ = notes.send(format!("the side question abort failed: {error:#}"));
                    }
                });
            }
            self.interrupt_running_work(view);
            self.show_ctrl_c_hint();
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
            self.cycle_detail(view);
            return Ok(());
        }
        // TS `app.subagents.focus` (default alt+a): the dock takes focus
        // while it renders (an unmounted dock keeps the editor's focus).
        if view
            .editor
            .keybindings()
            .matches(&id, "app.subagents.focus")
        {
            self.focus_subagents_summary(DockFocusSource::Shortcut, view);
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
        // the same submit ladder as Enter, but the message parks on the
        // follow-up lane and delivers when the run goes idle. While a
        // queued message is selected, the edit re-parks it there instead
        // (TS `handleFollowUp`'s browsing branch). An empty follow-up is
        // TS `handleFollowUp`'s silent no-op: never submitted, never
        // dispatched to the daemon.
        if view
            .editor
            .keybindings()
            .matches(&id, "app.message.followUp")
        {
            if self.queue_selection.is_browsing() || !view.editor.get_text().trim().is_empty() {
                view.editor.submit();
                for event in view.editor.take_events() {
                    if let crate::editor::EditorEvent::Submitted(text) = event {
                        if self.queue_selection.is_browsing() {
                            self.apply_queue_selection(&text, QueueLane::FollowUp, view)
                                .await?;
                        } else {
                            view.editor.add_to_history(&text);
                            self.submit_prompt(&text, SubmitBehavior::FollowUp, view)
                                .await?;
                        }
                    }
                }
            }
            self.dirty = true;
            return Ok(());
        }
        // Tab in a picker-command argument context opens that command's
        // menu prefilled with the typed partial: `/model <partial>` Tab
        // opens the model picker filtered to the match, `/mcp <partial>`
        // Tab the connections view filtered. The menu-only commands have
        // no typed-arg execution, so the partial's only destination is the
        // picker's filter. An open completion dropdown keeps its own Tab
        // (apply the selection); the interception is the no-menu path.
        if view.editor.keybindings().matches(&id, "tui.input.tab")
            && !view.editor.is_showing_autocomplete()
        {
            if let Some((command, partial)) = view.editor.picker_argument_context() {
                // The menu takes the Tab: a completion request parked by
                // this same press (before the idle tick) must not
                // materialize a dropdown over the menu on the next tick.
                view.editor.cancel_autocomplete();
                // The menu also takes the frame from a queue browse: the
                // parked message keeps its text (the typed partial is the
                // command being fulfilled now), and the next Enter submits
                // a prompt instead of routing into apply_queue_selection,
                // which would delete or replace the still-selected message.
                // Ending the browse restores the stashed draft like every
                // other leave-browse path (Esc, an applied queue edit), so
                // the editor never strands the browsed message's text and
                // a failed menu open loses nothing: the draft returns.
                if matches!(command.as_str(), "model" | "mcp") {
                    if self.queue_selection.has_draft() {
                        let draft = self.queue_selection.reset();
                        view.editor.set_text(&draft);
                        self.picker_restored_draft = true;
                    } else {
                        self.queue_selection.reset();
                    }
                    self.sync_queue_selection(view);
                }
                match command.as_str() {
                    "model" => {
                        self.open_model_picker(view, partial.trim()).await?;
                        // The flag belongs to the mounted picker: the
                        // model picker always mounts here, so a guard is
                        // belt-and-braces, but the failed-open contract
                        // stays symmetric with the mcp arm.
                        if view.model_picker.is_none() {
                            self.picker_restored_draft = false;
                        }
                        self.track_menu_opened("model", "tab");
                        self.dirty = true;
                        return Ok(());
                    }
                    "mcp" => {
                        self.open_mcp_view("/mcp", view, partial.trim()).await?;
                        // A failed roster load leaves no view mounted:
                        // the editor keeps the restored draft (nothing
                        // lost), but the flag must not leak into the NEXT
                        // picker — its clear-on-apply semantics belong to
                        // the typed partial, not this draft.
                        if view.mcp_view.is_none() {
                            self.picker_restored_draft = false;
                        }
                        self.track_menu_opened("mcp", "tab");
                        self.dirty = true;
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
        // TS `CustomEditor.handleInput`'s move-below-prompt hook
        // (`onMoveBelowPrompt` -> `focusSubagentSummary`): Down at the end
        // of the prompt — no autocomplete open, no history browse, the
        // cursor at the last line's end — hands the focus to the subagent
        // summary line when it is selectable; every other Down falls
        // through to the editor's cursor motion (a non-selectable line
        // never takes it). TS `SubagentSummaryLine.isSelectable()` grants
        // the grab only when subagents exist — the dock's other groups
        // keep their `app.subagents.focus` shortcut, so the prompt's
        // arrows stay the input-history recall in every session shape.
        if view
            .editor
            .keybindings()
            .matches(&id, "tui.editor.cursorDown")
            && !view.editor.is_showing_autocomplete()
            && !view.editor.is_history_navigation_active()
            && view.editor.is_cursor_at_end()
            && self.focus_subagents_summary(DockFocusSource::PromptDown, view)
        {
            // The focus leaves the editor with the selection active: a
            // later keystroke would fall back through to the editor and
            // replace the stale range, so the selection collapses with
            // the handoff.
            view.editor.clear_selection();
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
            match event {
                crate::editor::EditorEvent::Submitted(text) => {
                    if self.queue_selection.is_browsing() {
                        // Enter steers the selected parked message: the edit
                        // replaces it and moves it onto the steering lane
                        // (TS `applyQueueSelection(text, "steering")`).
                        self.apply_queue_selection(&text, QueueLane::Steering, view)
                            .await?;
                    } else {
                        view.editor.add_to_history(&text);
                        self.submit_prompt(&text, SubmitBehavior::Steer, view)
                            .await?;
                    }
                }
                crate::editor::EditorEvent::ClipboardWrite(text) => {
                    // A selection cut/copy. On a live terminal it takes
                    // TS `copySelection`'s shape exactly: the OSC 52
                    // sequence goes straight to the terminal (it works
                    // locally, over SSH, and through tmux
                    // `set-clipboard`), the same write the mouse
                    // selection's `copy_selection` below performs. The
                    // platform-tool chain (child processes whose
                    // `wait()` has no timeout) never runs on this path:
                    // a stalled xclip/wl-copy/pbcopy can neither freeze
                    // the prompt nor leak an unkillable blocking task,
                    // and no background task accumulates. The toast is
                    // success-only; a failed write shows the error row.
                    // A headless run has no terminal to write to and no
                    // stalling children (the tools fail to spawn
                    // instantly), so it keeps the synchronous platform
                    // chain and its captured OSC sink stays verifiable.
                    if std::io::IsTerminal::is_terminal(&std::io::stdout()) {
                        use std::io::Write;
                        // The sequence goes through `osc52::sequence`, so
                        // the encoded-payload cap applies to this path
                        // like every other OSC 52 write: an oversized
                        // sequence desynchronizes the terminal, so the
                        // copy reports failure instead of writing it.
                        match crate::osc52::sequence(&text) {
                            Some(sequence) => {
                                let mut out = std::io::stdout();
                                match out.write_all(sequence.as_bytes()) {
                                    Ok(()) => {
                                        let _ = out.flush();
                                        self.toast("Copied selection to clipboard", view);
                                    }
                                    Err(error) => {
                                        self.error_row(
                                            &format!("Failed to copy selection: {error}"),
                                            view,
                                        );
                                    }
                                }
                            }
                            None => {
                                self.error_row("Failed to copy selection to clipboard", view);
                            }
                        }
                    } else {
                        match crate::clipboard::copy_to_clipboard(&text, &mut self.osc_sink) {
                            Ok(()) => self.toast("Copied selection to clipboard", view),
                            Err(message) => self.error_row(&message, view),
                        }
                    }
                }
                _ => {}
            }
        }
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
                // TS #2458 `daemonClosingNotice`: the announcement is the
                // discriminator the interactive loop's shutdown recovery
                // arms on (a bare session stop without it stays stopped).
                self.daemon_closing_notice = Some(reason.clone());
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
            // `broadcastGlobal`): the scoped catalog refreshes in the
            // background through the update channel (TS
            // `refreshHeartbeatCatalog`) — an open `/heartbeats` view
            // re-renders from the landed update, and the activity dock's
            // counts follow the catalog even with the view closed
            // (another client's pause/resume reaches the dock at once).
            DaemonClientEvent::HeartbeatsChanged => {
                self.spawn_heartbeat_refresh();
            }
            // A background daemon-side catalog refresh changed the served
            // snapshot (the Rust-only no-stall picker-open extension):
            // every client re-fetches instantly — the daemon answers from
            // the warm caches, no stall — and an open `/model` picker
            // folds the fresh catalog through its stable update path
            // (`apply_model_catalog` keeps the selection), no flicker.
            DaemonClientEvent::ModelCatalogChanged => {
                self.spawn_model_catalog_refresh();
            }
            // A worker replacement superseded the id this client holds:
            // the interactive loop re-attaches to the session's current id
            // (a silent rebind - the transcript rebuilds from the attach
            // snapshot, no banner).
            DaemonClientEvent::SessionBinding {
                previous_active_session_id,
                active_session_id,
            } => {
                if previous_active_session_id == self.active_session_id
                    && !active_session_id.is_empty()
                    && active_session_id != self.active_session_id
                {
                    self.pending_rebind = Some(active_session_id);
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
                // TS `agent_start` clears the pending tool map: no card
                // from a previous run settles on this one's failure.
                self.pending_tools.clear();
                self.aborted_tools.clear();
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
                // The failed frame's sweep owns the call: the run's late
                // tool frames land on nothing - not the card, not the
                // pending map, not the loader (TS: no component in the
                // cleared pending map).
                if !self.aborted_tools.contains(&tool_call_id) {
                    crate::snapshot::apply_tool_execution_start(
                        view,
                        &tool_call_id,
                        &tool_name,
                        args,
                    );
                    // TS `tool_execution_start` re-registers the call in the
                    // pending map (a card may predate a pending-state reset or
                    // arrive without its own streamed frame).
                    self.pending_tools.insert(tool_call_id.clone());
                    self.set_working_activity("Executing", false, view);
                }
            }
            TurnUpdate::ToolExecutionUpdate {
                tool_call_id,
                partial,
            } => {
                // A `starting` partial (python-kernel bootstrap) owns the
                // loader note (TS `setWorkingMessage`); other updates
                // leave any current note alone. The note rides the
                // landed-result gate: the aborted card's late frames must
                // not clobber the delivered turn's loader.
                let loader_message = crate::snapshot::working_message_from_update(&partial);
                if self.apply_tool_result(&tool_call_id, partial, false, true, view) {
                    if let (Some(message), Some(working)) = (loader_message, view.working.as_mut())
                    {
                        working.message = Some(message);
                    }
                }
            }
            TurnUpdate::ToolExecutionEnd {
                tool_call_id,
                result,
                is_error,
            } => {
                // The landed-result gate keeps the loader safe: after the
                // interrupt delivers the parked queue, a late end frame from
                // the aborted run must not rewrite the new turn's activity
                // label or clear its loader note.
                if self.apply_tool_result(&tool_call_id, result, is_error, false, view) {
                    self.set_working_activity("Waiting", false, view);
                    // The tool that owned the loader note finished executing
                    // (TS clears `workingMessage` in the tool's `finally`).
                    if let Some(working) = &mut view.working {
                        working.message = None;
                    }
                }
            }
            TurnUpdate::TurnEnded { error } => {
                // Only the engine's own turn_end clears the busy state:
                // trailing `agent_end` frames from the previous turn must
                // not cancel a turn admitted in between (prompt queueing).
                self.streaming_index = None;
                self.turn_ends_seen += 1;
                self.turn_active = false;
                view.working = None;
                view.working_since = None;
                view.retry = None;
                // The turn settled: the bash cards held above the
                // indicator stream into the transcript (TS `turn_end`
                // flushes `pendingBashComponents`).
                self.flush_pending_bash(view);
                // TS `turn_end` clears the pending tool map after the
                // failed frame's settle: stragglers never leak into the
                // next run.
                self.pending_tools.clear();
                self.aborted_tools.clear();
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
                //
                // SANCTIONED DIVERGENCE (operator ruling 2026-09-23): the
                // just-failed attempt's error row leaves the chat — the
                // transient loader line (error + attempt + countdown,
                // updated in place) is the ONE error the chat shows while
                // the episode runs, and the episode's durable outcome row
                // replaces it at the settle. (TS keeps one error row per
                // failed attempt; a 429-storm spammed the chat.)
                pop_superseded_attempt_row(view);
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
                attempt: _,
                final_error,
                restored_model,
            } => {
                view.retry = None;
                if final_error.is_some() {
                    self.turn_error_shown = true;
                    // The give-up's final failed attempt is superseded by
                    // the ONE terminal line (the durable outcome row that
                    // follows this event renders it; the row text matches
                    // the old live banner).
                    pop_superseded_attempt_row(view);
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
                // replaces the working loader for the run's duration. The
                // generation bump retires every in-flight abort outcome
                // that addressed an earlier run's loader.
                view.working = None;
                view.compaction_generation += 1;
                view.compaction = Some(CompactionState {
                    reason: CompactionReason::parse(&reason),
                    custom_instructions,
                    // A fresh run starts with an empty live summary:
                    // the deltas of THIS run accumulate from here (a
                    // replayed `compaction_start` after a re-attach
                    // drops the previous run's partial text too).
                    summary: String::new(),
                });
            }
            TurnUpdate::CompactionSummaryDelta { delta } => {
                // One streamed chunk of the summary the compaction
                // model is generating: append onto the live loader's
                // state (the expanded view renders the accumulated
                // text under the loader, nested like the expanded
                // summary row that settles it). A delta without a live
                // loader (a late attach mid-run, a stale frame after
                // `compaction_end`) drops — the settling end still
                // carries the full summary.
                if let Some(compaction) = view.compaction.as_mut() {
                    compaction.summary.push_str(&delta);
                }
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
                exclude_from_context,
                transient,
                run_id,
            } => {
                self.apply_bash_start(command, exclude_from_context, transient, run_id, view);
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
                starting,
                rlm_child_status,
            } => {
                view.queued = crate::queued::QueuedMessages {
                    steering,
                    follow_ups,
                    starting,
                    rlm_child_status,
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

    /// TS `interruptOrClearInput`'s abort ladder, shared by the Ctrl+C and
    /// Escape interrupts: a compacting session aborts the compaction run,
    /// a streaming turn aborts through `abort_and_send_queued` (schema 29),
    /// and a running user bash aborts alongside. The side-question abort
    /// stays at the call sites — the two keys dispose of its pane
    /// differently.
    fn interrupt_running_work(&self, view: &AgentView) {
        // TS `interruptOrClearInput` aborts the trace upload sweep first
        // (the handler shows the cancelled row when the run settles).
        if let Some(run) = &self.trace_upload {
            run.cancel.cancel();
        }
        if view.compaction.is_some() {
            // The compaction loader is up (TS `isAgentCompacting()`):
            // the interrupt cancels the compaction run only — the agent
            // is not streaming, so no turn abort goes out, exactly like
            // the TS interrupt key.
            self.abort_compaction(view.compaction_generation);
        } else if self.turn_active {
            // TS shows no transient abort hint: the aborted turn's own
            // assistant row carries the interrupt (the red "Operation
            // aborted" error row inside the message component), so
            // nothing is noted here.
            self.abort_turn();
        }
        // A running user-bash command aborts the same way (TS
        // `interruptOrClearInput` fires `void abortBash()`): the settled
        // run reports cancelled through its bash_end.
        if self.user_bash_running {
            self.abort_user_bash();
        }
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
            self.record_speed_sample(message, view);
        }
        if let Some(text) = blocks.iter().rev().find_map(|block| match block {
            MessageBlock::Text(text) => Some(text.clone()),
            MessageBlock::Thinking(_) => None,
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
                view.prepare_entry_mutation(index);
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
            // streaming call winning at component creation). The failed
            // run's late frames touch no card either (the settled card
            // keeps its sweep-written result).
            if !self.aborted_tools.contains(id) {
                crate::snapshot::apply_streamed_tool_card(view, id, name, args);
            }
            if starts_message {
                // A new assistant message re-arms a reused id (TS builds a
                // fresh pending component for the new invocation); a late
                // `message_update` from a failed run must not. The re-armed
                // invocation's next streamed frame pushes its own fresh card
                // — the settled card is skipped by its `aborted` flag, the
                // way TS's cleared pending map forces a new component.
                self.aborted_tools.remove(id);
            }
            // TS `message_update` registers every streamed call in the
            // pending map (`message_start` and the final frame never do:
            // their cards either already settled or get the failed frame's
            // sweep); the failed run's late frames stay out too.
            if streaming && !starts_message && !self.aborted_tools.contains(id) {
                self.pending_tools.insert(id.clone());
            }
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
        // TS `message_end`'s failed-frame block: an aborted run's row text
        // is the client's own — the retry count and the working-elapsed
        // suffix never ride the wire (the rebuild keeps the stored
        // "Operation aborted") — and every still-pending tool card settles
        // with the failure text; late result frames land on nothing.
        let stop_reason = message.get("stopReason").and_then(Value::as_str);
        let abort_text = if stop_reason == Some("aborted") {
            Some(crate::chat::live_abort_text(
                view.retry.as_ref().map_or(0, |retry| retry.attempt),
                view.working_since.map(|since| since.elapsed().as_secs()),
            ))
        } else {
            None
        };
        if abort_text.is_some() || stop_reason == Some("error") {
            let settle_text = abort_text.clone().unwrap_or_else(|| {
                message
                    .get("errorMessage")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .unwrap_or("Error")
                    .to_string()
            });
            crate::snapshot::settle_pending_tool_cards(
                view,
                &mut self.pending_tools,
                &mut self.aborted_tools,
                &settle_text,
            );
        }
        let Some(error) = crate::snapshot::assistant_error_row(message, tool_calls) else {
            return;
        };
        let error = match abort_text {
            Some(text) => crate::snapshot::AssistantErrorRow {
                text,
                aborted: true,
            },
            None => error,
        };
        self.turn_error_shown = true;
        if let Some(index) = open {
            view.prepare_entry_mutation(index);
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
    /// Returns whether the result landed (a card exists and is not
    /// aborted): the caller's loader work rides the same gate — the
    /// aborted card's late frames must leave the loader untouched too
    /// (TS `tool_execution_end` does nothing without a pending
    /// component).
    fn apply_tool_result(
        &mut self,
        tool_call_id: &str,
        result: Value,
        is_error: bool,
        partial: bool,
        view: &mut AgentView,
    ) -> bool {
        let result = ToolResultView {
            content: result
                .get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            details: result.get("details").cloned().unwrap_or(Value::Null),
            is_error,
        };
        // The result lands on the newest card carrying the id: a re-armed
        // invocation pushed its own card, and the older settled card keeps
        // its sweep-written result (TS's pending map only ever holds the
        // current component).
        let card_index = view
            .chat
            .iter()
            .rposition(|entry| matches!(entry, ChatEntry::Tool(card) if card.id == tool_call_id));
        if let Some(index) = card_index {
            view.prepare_entry_mutation(index);
            if let Some(ChatEntry::Tool(card)) = view.chat.get_mut(index) {
                // The failed frame's sweep owns the call: the tool's late
                // result frames land on nothing (TS `tool_execution_end`
                // finds no component in the cleared pending map).
                if self.aborted_tools.contains(tool_call_id) || card.aborted {
                    return false;
                }
                card.result = Some(result);
                card.result_partial = partial;
                if !partial {
                    card.ended_at = Some(std::time::Instant::now());
                    self.pending_tools.remove(tool_call_id);
                }
                view.mark_entry_stale(index);
                return true;
            }
        }
        false
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
    crossterm::terminal::size().map_or(80, |(columns, _)| columns as usize)
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

    fn entry(job_json: serde_json::Value) -> HeartbeatEntry {
        HeartbeatEntry {
            job: parse_heartbeat_job(&job_json).expect("job parses"),
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
        let labeled = entry(job("labeled", "active"));
        let mut unlabeled = job("unlabeled", "active");
        unlabeled["label"] = serde_json::Value::Null;
        let unlabeled = entry(unlabeled);
        let paused = entry(job("b", "paused"));
        let catalog = vec![labeled, unlabeled, paused];
        assert_eq!(catalog.len(), 3);
        assert_eq!(paused_heartbeat_count(&catalog), 1);
        // An all-active catalog renders no paused suffix.
        let active = vec![entry(job("a", "active")), entry(job("c", "active"))];
        assert_eq!(paused_heartbeat_count(&active), 0);
    }

    /// Operator scoping: the session wrapper passes no child session ids,
    /// so a nested session's heartbeat drops while the session's own
    /// rows stay (TS `scopeHeartbeatsToSession` kept the children's jobs
    /// — the divergence lives in the caller).
    #[test]
    fn dock_heartbeats_scope_to_the_current_session_only() {
        let own = entry(job("own", "active"));
        // The child's durable session differs: with an empty child-id
        // list it must drop even though its active id also differs.
        let mut child = job("child", "active");
        child["activeSessionId"] = json!("child-live");
        child["sessionId"] = json!("sess-child");
        let child = entry(child);
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
