//! Live per-session UI state for the interactive loop: the daemon-client
//! side of one attached session — prompt submission, slash commands, streamed
//! event application, and session switching. Rendering itself lives in the
//! view crate modules; this module only decides what the view shows.

mod apply;
mod auth;
mod bash;
mod commands;
mod factory;
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
pub(crate) use factory::FactoryUpdate;
use heartbeats::paused_heartbeat_count;
pub(crate) use heartbeats::HeartbeatsUpdate;
/// The opening phase's echo gate (run.rs): the fresh-state projection of
/// `handle_key`'s keymap-aware ladder — a claimed key queues behind the
/// session open instead of echoing into the editor.
pub(crate) use keys::opening_echo_key_claimed;
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
use pa_types::daemon::{CycleDirection, DaemonCommand};
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

/// Cap on any daemon request awaited on the key-handling path: the UI
/// loop must stay responsive to Ctrl+C while a submission travels.
const UI_REQUEST_TIMEOUT_MS: u64 = 10_000;

/// Cap on the detach request during the exit path: the client must exit
/// promptly even when the worker socket is wedged.
const EXIT_DETACH_TIMEOUT_MS: u64 = 600;
/// Cap on the exit-path session-stats fetch: best-effort like the detach,
/// never able to hold the exit open.
const EXIT_STATS_TIMEOUT_MS: u64 = 500;

/// Ban-risk warning a completed Anthropic subscription login shows once
/// per session; the settings toggle `warnings.anthropicExtraUsage` gates it.
const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING: &str = "Anthropic subscription auth is active. Usage draws from your plan limits, but Prime Agent identifies as Claude Code and this may violate Anthropic's terms — your account can be restricted or banned. An Anthropic API key avoids the risk. Manage usage at https://claude.ai/settings/usage.";

/// A landed `get_commands` refresh: the session's `skill:` commands for
/// the autocomplete provider; an older refresh never applies.
pub(crate) struct CommandCatalogUpdate {
    pub epoch: u64,
    pub skill_commands: Vec<crate::autocomplete::SlashCommandEntry>,
}

pub(crate) fn attach_capabilities() -> Vec<DaemonClientCapability> {
    vec![
        "attach_snapshot".to_string(),
        "event_sequence".to_string(),
        "slim_attach".to_string(),
        "elide_snapshot_images".to_string(),
        "windowed_snapshot".to_string(),
    ]
}

pub(crate) struct TranscriptBackfillNote {
    pub epoch: u64,
    pub entries: Vec<ChatEntry>,
}

pub(crate) struct SessionUi {
    pub(crate) client: DaemonClient,
    pub(crate) active_session_id: String,
    pub(crate) session_id: String,
    /// The worker generation of this run's attach; the layout handoff pairs it with
    /// the attach's event sequence so a restarted worker never serves a stale handoff.
    pub(crate) attach_event_generation: String,
    /// The event sequence of this run's attach: the handoff's ADOPT keys on the next attach's value
    /// — a match means the re-entry rebuilt the handoff's exact entries.
    pub(crate) attach_event_sequence: u64,
    /// The LATEST event sequence — the attach's value, then the max over every event's
    /// `meta.sequence` — the handoff's STASH key, so a turn during the run advances it past the
    /// run's attach sequence.
    pub(crate) last_event_sequence: u64,
    /// Whether the attach supplied the resume cursor: a cursor-less attach stashes
    /// nothing — its collapsed empty/zero key could alias across attaches of the same entry count.
    pub(crate) attach_cursor_present: bool,
    session_name: Option<String>,
    cwd: PathBuf,
    session_dir: Option<PathBuf>,
    script_path: Option<PathBuf>,
    model_selection: ModelSelection,
    /// The `--models` scope patterns carried into every `create` config: the daemon resolves them
    /// per create, so a `/new` session keeps the scope.
    models: Option<Vec<String>>,
    /// The `/model` picker's catalog: a startup snapshot (the bundled
    /// fallback), replaced by the daemon's `get_model_catalog` response.
    model_catalog: Vec<pa_types::ai::Model>,
    model_configured_providers: std::collections::HashSet<String>,
    /// The settings recent-model list (`provider/id` keys, newest first).
    model_recent_models: Vec<String>,
    default_thinking_level: Option<String>,
    models_fetched_at: Option<std::time::Instant>,
    pasted_images: std::collections::BTreeMap<u64, LoadedImage>,
    next_image_marker_id: u64,
    telemetry_disabled: Option<bool>,
    code_block_indent: String,
    tree_filter_mode: crate::tree_list::FilterMode,
    branch_summary_skip_prompt: bool,
    /// The transcript index of the last `note` status row: consecutive
    /// notes rewrite it in place; any later entry invalidates it.
    last_status_index: Option<usize>,
    show_images: bool,
    fullscreen_mouse: bool,
    speed_display_enabled: bool,
    /// Per-session output tok/sec accumulation over completed responses;
    /// `None` until the first sample, a rebind restarts it.
    speed_stats: Option<SpeedStats>,
    service_tier: Option<String>,
    client_settings: Option<std::sync::Arc<dyn crate::client_settings::ClientSettings>>,
    /// The ban-risk warning's view-local dedup (TS
    /// `anthropicSubscriptionWarningShown`): this VIEW's own
    /// once-per-instance gate. The once-per-SESSION-lifecycle gate (the
    /// operator 2026-09-29 fix for the every-open re-warn) is the
    /// daemon-side marker read through `get_state` — see
    /// [`Self::anthropic_warning_already_shown`] and
    /// [`Self::mark_anthropic_warning_shown`].
    anthropic_subscription_warning_shown: bool,
    /// The in-flight `mark_anthropic_warning_shown` fire-and-forget: set
    /// when the mark task is spawned, cleared by the task itself at its
    /// end (ack, error, or bound) — the headless exit gate reads it so a
    /// scripted run never ends with the durable write still in flight.
    anthropic_warning_mark_pending: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The side-question run currently streaming (TS `activeSideQuestionId`):
    /// at most one run per client, exactly like the daemon enforces.
    active_side_question_id: Option<String>,
    side_question_counter: u64,
    /// A `/share` gist upload in flight: aborting kills `gh` (kill-on-drop).
    share: Option<ShareRun>,
    share_notes: mpsc::UnboundedSender<ShareNote>,
    reload: Option<tokio::task::JoinHandle<()>>,
    reload_notes: mpsc::UnboundedSender<ReloadNote>,
    trace_upload: Option<TraceUploadAllRun>,
    traces_upload_notes: mpsc::UnboundedSender<crate::traces::TraceUploadAllNote>,
    pending_traces_login: Option<TracesLoginIntent>,
    /// The in-flight traces login's enable intent: taken from the park
    /// when the flow spawns, consumed by the settle.
    traces_login_run: Option<TracesLoginIntent>,
    /// The generation of the in-flight traces login: a late settle from a
    /// superseded run never clears the newer login's panel.
    traces_login_gen: u64,
    catalog_updates: mpsc::UnboundedSender<ModelCatalogUpdate>,
    heartbeat_updates: mpsc::UnboundedSender<HeartbeatsUpdate>,
    pending_snapshot: Option<Vec<ChatEntry>>,
    /// One-shot: free the heap of the first frame rendered after an attach fold — the
    /// frame's visible-window materialization is its own, bigger transient.
    trim_after_frame: bool,
    pending_model: Option<String>,
    pending_model_provider: Option<String>,
    pending_thinking_suffix: Option<String>,
    pending_queue: Option<crate::queued::QueuedMessages>,
    queue_selection: crate::queued::QueueSelection,
    context: Option<crate::chrome::ContextUsage>,
    list_rows: Vec<Value>,
    pub(crate) turn_active: bool,
    /// Completed turns observed on this connection. A prompt ACK may arrive
    /// after its entire streamed turn; it must not restart the loader then.
    turn_ends_seen: u64,
    last_prompt_turn_end: u64,
    /// The session's queue delivery mode: `all` delivers the queued steering prefix as one batched
    /// turn at the boundary; `one-at-a-time` one per turn (product default `all`).
    pub(crate) steering_mode: String,
    streaming_index: Option<usize>,
    working_tokens: LoaderTokenTracker,
    /// The turn already surfaced its error (a failed assistant message or
    /// a retry-exhausted banner); the `turn_end` error stays silent then.
    turn_error_shown: bool,
    /// Tool cards awaiting their final result: registered at their `message_update` or
    /// `tool_execution_start` frame, unregistered by the final result; a failed final frame settles
    /// every pending card.
    pending_tools: std::collections::HashSet<String>,
    /// Tool calls settled by a failed final frame, card or not: late tool
    /// frames land on nothing (a new assistant message re-arms a reused id).
    aborted_tools: std::collections::HashSet<String>,
    pub(crate) last_assistant_text: Option<String>,
    pub(crate) osc_sink: crate::clipboard::OscSink,
    pending_confirm: Option<PendingConfirm>,
    traces: Option<crate::traces::TracesCommandsHandle>,
    provider_auth: Option<crate::provider_auth::ProviderAuthCommandsHandle>,
    /// A model selection parked on the provider's sign-in: the picker applied a model whose
    /// provider is not signed in, and a successful login retries the switch automatically.
    pending_model_sign_in: Option<PendingModelSignIn>,
    auth_panel_notes: mpsc::UnboundedSender<crate::auth_panel::AuthPanelRequest>,
    /// The running panel login's cooperative cancel signal: armed only by flows that
    /// check it between poll steps; a cancelled flow never writes its credential.
    auth_panel_cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    update_commands: Option<crate::update_command::UpdateCommandsHandle>,
    update_notes: mpsc::UnboundedSender<UpdateNote>,
    update_in_flight: bool,
    pub(crate) exit_requested: bool,
    pub(crate) open_agents_view: bool,
    pub(crate) scoped_agents_view: Option<crate::agents_view::AgentsViewScope>,
    roster: Vec<Value>,
    heartbeat_catalog: Vec<HeartbeatEntry>,
    heartbeat_refresh_in_flight: bool,
    heartbeat_refresh_queued: bool,
    heartbeat_refresh_epoch: u64,
    command_updates: mpsc::UnboundedSender<CommandCatalogUpdate>,
    command_refresh_epoch: u64,
    skill_commands_cache: Vec<crate::autocomplete::SlashCommandEntry>,
    bash_activities: Value,
    /// Monotonic id of the latest issued kernel-bash list request; a late response from an older
    /// request must not repaint a newer snapshot.
    bash_list_epoch: u64,
    bash_updates: mpsc::UnboundedSender<BashActivityUpdate>,
    /// The last `factory_activity` graph reply (the dock count's cache and
    /// the page open's mount, the `bash_activities` pattern): the
    /// always-on 2s poll keeps it current whether or not the page is
    /// open.
    factory_graph: serde_json::Value,
    /// The durable session id the open `/factory` view was mounted on: the
    /// rebind fold keeps the view across a same-session reattach (`Unknown
    /// active session` recovery) and closes it only when a different
    /// session actually takes the view's place.
    factory_view_session: Option<String>,
    /// Whether one factory refresh is still in flight (the heartbeat
    /// refresh's serialization: the tick is only a cadence floor, so it
    /// queues behind the in-flight cycle instead of minting a newer epoch
    /// the in-flight reply could never match).
    factory_refresh_in_flight: bool,
    /// A tick that fired while a refresh was in flight: the fold launches
    /// this trailing refresh once the in-flight cycle delivers.
    factory_refresh_queued: bool,
    /// Monotonic id of the latest issued factory refresh; an older
    /// response never repaints a newer snapshot.
    factory_list_epoch: u64,
    /// Where background factory refreshes deliver the run graph (the run
    /// loop folds them into the open view).
    factory_updates: mpsc::UnboundedSender<FactoryUpdate>,
    /// The open view's selected run id: the refresh's watch target.
    factory_selected_run: Option<String>,
    /// The subagent summary line holds keyboard focus.
    subagents_focused: bool,
    activity_group: crate::chrome::ActivityGroup,
    subagent_counts: crate::subagents::SubagentCounts,
    /// This session's persisted file path (family identity of the
    /// subagent linkage; `None` for unpersisted sessions).
    session_file: Option<String>,
    pub(crate) pending_selection: Option<SessionSelection>,
    /// Whether this run may hand the terminal back to the agents view:
    /// false only for `--no-session` runs.
    pub(crate) return_to_agents_view: bool,
    client_auth: Option<crate::client_auth::ClientAuthCommandsHandle>,
    keybindings: crate::keybindings::KeybindingsManager,
    prompt_stash: std::sync::Arc<std::sync::Mutex<crate::prompt_stash::PromptStashStore>>,
    stash_session_id: String,
    pub(crate) dirty: bool,
    /// The Ctrl+C exit hint: a second press inside the window terminates
    /// the client, regardless of turn state.
    ctrl_c_hint_until: Option<Instant>,
    pub(crate) goal_view: GoalView,
    notes: mpsc::UnboundedSender<String>,
    compaction_abort_notes: mpsc::UnboundedSender<CompactionAbortNote>,
    /// The ordered inbox the single submit worker drains: one in-flight request at a time keeps the
    /// wire in submit order while the key path stays free of the round trip; the worker owns its
    /// outcome sender.
    prompt_orders: mpsc::UnboundedSender<PromptOrder>,
    /// Monotonic submit generation: every submit bumps it, and a failed
    /// one's draft-restore right dies under any newer submit.
    input_submission_generation: u64,
    /// Armed prompt round trips (one per spawned request): the headless
    /// idle and exit gates treat an in-flight submit as busy.
    prompt_in_flight: usize,
    pub(crate) transcript_stale: bool,
    transcript_epoch: u64,
    pub(crate) transcript_backfill: Option<tokio::task::JoinHandle<()>>,
    pending_backfill: Option<usize>,
    backfill_notes: mpsc::UnboundedSender<TranscriptBackfillNote>,
    /// Adoption telemetry (counted into `tui exit`); `None` drops events.
    pub(crate) telemetry: Option<std::sync::Arc<dyn crate::interactive::InteractionTelemetry>>,
    scroll_adoption_emitted: bool,
    pub(crate) exit_reason: &'static str,
    /// The §10 reattach contract: set when a `daemon_closing` update frame
    /// arrived; the interactive loop drives the reconnect from it.
    pub(crate) reconnect: Option<crate::daemon_client::DaemonClosingUpdate>,
    /// The reason the daemon last announced itself closing; cleared once a fresh attach
    /// (re)establishes the connection. An announced `shutdown` arms the bounded shutdown recovery,
    /// so a bare session stop never routes into a reconnect.
    pub(crate) daemon_closing_notice: Option<String>,
    pub(crate) transport_lost: Option<String>,
    pub(crate) pending_rebind: Option<String>,
    /// The re-attach window expired: dispatch is blocked and submits
    /// surface the error instead of leaving the UI on a silent spinner.
    pub(crate) reconnection_failed: Option<String>,
    pub(crate) exit_guard: crate::exit_guard::ExitGuard,
    /// The armed double-Escape action: "tree" or "clear", taken by the
    /// second press inside the 500ms window.
    escape_repeat_action: Option<&'static str>,
    escape_repeat_until: Option<Instant>,
    /// Whether the double-Escape tree shortcut already fired for this input chain (operator ruling
    /// 2026-09-29: the repeat-opened tree's dismissal must not re-enter the open cycle).
    escape_tree_shortcut_spent: bool,
    /// The `!`/`!!` user-bash lane's client-side running flag (optimistic on
    /// submit, patched by `bash_start`/`bash_end`).
    user_bash_running: bool,
    user_bash_card: Option<String>,
    user_bash_started_at: Option<std::time::Instant>,
    user_bash_counter: u64,
    /// The attached snapshot's bash slot state, consumed by the next
    /// transcript rebuild: a same-session resync runs the `bashFinished` edge off it.
    resync_bash: Option<ResyncBash>,
    /// The LAST HUMAN PROMPT's wall-clock time (unix ms) from the attach snapshot's newest user
    /// message: the rebuilt loader anchors its elapsed clock here (operator ruling 2026-09-28: the
    /// waiting/executing timer never resets on a view transition).
    loader_anchor_ms: Option<u64>,
    /// An in-flight side-conversation bash run: its pane-mounted identity plus
    /// whether it seeds follow-up side questions (the `!` variant, not `!!`).
    side_bash: Option<SideBashRun>,
    /// A discarded side-bash run whose `bash_*` events are swallowed until
    /// its own `bash_end`.
    side_bash_discarded: Option<String>,
    side_bash_counter: u64,
    /// `app.suspend` (default ctrl+z) requested the process-group suspend: the interactive
    /// loop performs the cycle right after dispatch, because the renderer is the loop's terminal.
    suspend_requested: bool,
    external_editor_request: Option<String>,
    /// The `/mcp` view's internal auth resolution: the loop mounts the panel
    /// and spawns the command through the auth seam, never the typed-command path.
    pending_mcp_auth: Option<McpAuthIntent>,
    /// The editor holds the user's own text (the Tab path's restored browse draft, or the text
    /// ctrl+l opened the picker over), not a typed command partial: a picker apply must keep it.
    picker_restored_draft: bool,
    suspend_adoption_emitted: bool,
    selection_auto_scroll: Option<SelectionAutoScroll>,
    selection_adoption_emitted: bool,
    /// Texts copied out by finished selections this run (headless runs
    /// have no terminal to write OSC 52 to; the verifier reads these).
    pub(crate) copies: Vec<String>,
    pub(crate) pressed_hyperlink: Option<String>,
    pub(crate) left_mouse_dragged: bool,
    /// Links opened by clicks this run (headless runs have no terminal to
    /// hand a browser to; the verifier reads these).
    pub(crate) opened_urls: Vec<String>,
    /// The click target under the last plain left press: the release fires it
    /// when it lands on the same row without a drag between.
    pub(crate) pressed_click: Option<PressedClick>,
    click_adoption_emitted: bool,
}

/// The reattach outcome for `reattach_after_recovery`: the budget expiry (a queued attach waiting
/// out a slow restore, §10.4) is a RETRY outcome; only a true attach error is an `Err`.
pub(crate) enum ReattachOutcome {
    Attached,
    AttachBudgetExceeded,
}

pub(crate) enum RebuildKind {
    /// A new session took the view's place (`/new`, `/switch`, startup):
    /// the previous session's held cards die with its transcript.
    Rebind,
    /// The same session re-attached after an update restart (§10): the held cards stay
    /// mounted and the `bashFinished` edge settles a run that ended behind the dead link.
    Resync,
}

/// Where a compact-dock focus hand-off comes from (TS
/// `focusSubagentSummary`, shared by `app.subagents.focus` and the
/// editor's move-below-prompt hook): the landing group differs per
/// caller.
enum DockFocusSource {
    /// The editor's Down at the prompt's end (TS `onMoveBelowPrompt`
    /// -> `focusSubagentSummary`): lands on the subagents group.
    PromptDown,
    Shortcut,
}

/// How the attach settles the dock's data before the rebuild renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DockFold {
    /// Clear and fold the first `heartbeats_list` and `list_kernel_bash` responses into the session
    /// before the attach returns: the dock's counts are first-frame state — the first content frame
    /// reads the final counts.
    FirstFrame,
    /// Clear and hand the dock to the background refreshes: a brand-new session owns nothing, so
    /// its dock is deterministically empty — waiting on two registry reads would only delay the
    /// first frame.
    Fresh,
    /// Hold the dock's data and let the background refreshes update it: a same-session re-attach of
    /// an already-up surface (§10.4 recovery, session reconnect) must not flicker its dock away.
    Held,
}

impl SessionUi {
    /// Take the one-shot post-first-frame trim request.
    pub(crate) fn take_trim_after_frame(&mut self) -> bool {
        std::mem::take(&mut self.trim_after_frame)
    }

    /// Hand the keyboard focus to the compact dock on its selected group (operator ruling
    /// 2026-09-26: leaving a panel lands on the panel's own dock item, never the prompt bar).
    fn focus_activity_dock(&mut self, view: &mut AgentView) {
        self.subagents_focused = true;
        self.update_subagent_summary(view);
    }

    /// Materialize parked editor autocomplete requests once the input queue drains (the editor
    /// defers dropdown materialization past the keystroke batch).
    pub(crate) fn materialize_editor_autocomplete(&mut self, view: &mut AgentView) {
        let was_showing = view.editor.is_showing_autocomplete();
        let was_pending = view.editor.has_pending_autocomplete();
        view.editor.materialize_autocomplete();
        for event in view.editor.take_events() {
            if let crate::editor::EditorEvent::Changed(text) = event {
                if !text.is_empty() {
                    self.clear_ctrl_c_hint();
                }
                self.dirty = true;
            }
        }
        if view.editor.is_showing_autocomplete() != was_showing {
            self.dirty = true;
        }
        // A background `@` search resolving repaints even when the menu was already open:
        // its rows are replaced in place, so the showing-state check above cannot see it.
        if was_pending && !view.editor.has_pending_autocomplete() {
            self.dirty = true;
        }
    }

    fn session_display(&self) -> String {
        self.session_name
            .clone()
            .unwrap_or_else(|| crate::chrome::display_name(&self.cwd.to_string_lossy()))
    }

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

    /// Recompute the model-eligibility autocomplete state (`/fast` hidden when the model is not
    /// fast-mode-eligible): call after every point the model id or tier can move.
    fn update_model_eligibility_filters(&self, view: &mut AgentView) {
        let eligible = self
            .current_model_entry(view)
            .is_some_and(pa_types::ai::supports_fast_mode);
        let mut hidden = std::collections::HashSet::new();
        if !eligible {
            hidden.insert("fast".to_string());
        }
        view.editor.set_autocomplete_hidden_commands(hidden);
        view.editor
            .set_autocomplete_argument_completions("tier", self.tier_completion_items(view));
    }

    /// The `/tier` choices (`scale` is not a user-facing choice): `default` plus
    /// the tiers the current model supports, in the TS order.
    fn available_service_tiers(&self, view: &AgentView) -> Vec<&'static str> {
        let Some(model) = self.current_model_entry(view) else {
            return vec!["default"];
        };
        let mut tiers = vec!["default"];
        for tier in [
            pa_types::ai::ServiceTier::Flex,
            pa_types::ai::ServiceTier::Priority,
            pa_types::ai::ServiceTier::Auto,
        ] {
            if pa_types::ai::supports_service_tier(model, tier) {
                tiers.push(match tier {
                    pa_types::ai::ServiceTier::Flex => "flex",
                    pa_types::ai::ServiceTier::Priority => "priority",
                    pa_types::ai::ServiceTier::Auto => "auto",
                    _ => unreachable!("the loop names every choice"),
                });
            }
        }
        tiers
    }

    fn tier_completion_items(&self, view: &AgentView) -> Vec<crate::autocomplete::CompletionItem> {
        let current = self.service_tier.as_deref().unwrap_or("default");
        self.available_service_tiers(view)
            .into_iter()
            .map(|tier| {
                // The one descriptions owner: the settings row's submenu
                // exports the TS `SERVICE_TIER_OPTIONS` table.
                let description = crate::settings_menu::service_tier_description(tier);
                let description = if tier == current {
                    format!("{description} (current)")
                } else {
                    description.to_string()
                };
                crate::autocomplete::CompletionItem {
                    value: tier.to_string(),
                    label: tier.to_string(),
                    description: Some(description),
                    argument_hint: None,
                    source_tag: None,
                }
            })
            .collect()
    }

    /// `/tier [tier]`: without an argument report the current tier and the available ones; an
    /// unsupported tier errors with the available list; a supported one applies through the same
    /// daemon switch as `/fast`.
    async fn handle_tier_command(&mut self, view: &mut AgentView, args: &str) {
        let tiers = self.available_service_tiers(view);
        let requested = args.trim().to_lowercase();
        if requested.is_empty() {
            let current = self.service_tier.as_deref().unwrap_or("default");
            self.note(
                &format!("Service tier: {current} (available: {})", tiers.join(", ")),
                view,
            );
            return;
        }
        if !tiers.contains(&requested.as_str()) {
            self.error_row(
                &format!(
                    "Service tier '{requested}' is not available for the current model. Available: {}",
                    tiers.join(", ")
                ),
                view,
            );
            return;
        }
        let Ok(tier) =
            serde_json::from_value::<pa_types::ai::ServiceTier>(Value::String(requested.clone()))
        else {
            self.error_row(&format!("Unknown service tier: {requested}"), view);
            return;
        };
        let switched = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::SetServiceTier {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    service_tier: Some(tier),
                    rest: Map::default(),
                },
            )
            .await;
        if let Err(error) = switched {
            self.error_row(&format!("{error:#}"), view);
            return;
        }
        // The status row reports what the session actually applied; a state read that fails or
        // omits the tier shows no success row — the stale local tier must not report an apply that
        // did not confirm.
        let Some(state) = self.connection_state(view).await else {
            return;
        };
        let Some(applied) = state
            .get("serviceTier")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        self.service_tier = Some(applied.clone());
        view.chrome.service_tier = Some(applied.clone());
        self.update_model_eligibility_filters(view);
        self.note(&format!("Service tier: {applied}"), view);
    }

    /// The images whose markers are present in `text`, or `None` when there are none: attachments
    /// always reach the session — a text-only session model is routed to `settings.imageModel` at
    /// dispatch or the turn fails there, so nothing is silently downgraded.
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

    pub(crate) fn prompt_submits_in_flight(&self) -> usize {
        self.prompt_in_flight
    }
}

impl SessionUi {
    pub(crate) fn reload_pending(&self) -> bool {
        self.reload.is_some()
    }

    /// The settled external-editor round trip: a saved text replaces the editor draft; a non-zero
    /// exit keeps it (TS is silent); an IO/spawn failure surfaces the error row TS swallows.
    pub(crate) fn apply_external_editor_outcome(
        &mut self,
        outcome: anyhow::Result<Option<String>>,
        view: &mut AgentView,
    ) {
        let settled = match outcome {
            Ok(Some(text)) => {
                view.editor.set_text(&text);
                // The saved draft no longer carries the markers the registry describes; clear it
                // the way submit does (TS keeps the stale registry: the same latent bug).
                view.editor
                    .restore_paste_snapshot(crate::editor::EditorPasteSnapshot::default());
                "applied"
            }
            Ok(None) => "unchanged",
            Err(error) => {
                self.error_row(&format!("{error:#}"), view);
                "failed"
            }
        };
        if let Some(telemetry) = self.telemetry.clone() {
            tokio::spawn(async move {
                telemetry.external_editor_used(settled).await;
            });
        }
        self.dirty = true;
    }

    /// Whether the `/mcp` view parked an auth request for the loop to spawn.
    pub(crate) fn pending_mcp_auth(&self) -> bool {
        self.pending_mcp_auth.is_some()
    }

    /// The `tui exit` reason recorded at the point the loop stopped.
    pub(crate) fn exit_reason(&self) -> &'static str {
        self.exit_reason
    }
}

#[cfg(test)]
mod loader_anchor_tests {
    use super::SessionUi;

    /// The anchor clock (Macroscope 2026-09-28: a prompt's age must not be
    /// capped — the retired 24-hour cutoff reset old prompts to a zero loader).
    #[test]
    fn prompts_anchor_at_their_wall_time_and_future_ones_fall_back() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or_default();
        let recent = SessionUi::loader_anchor_instant(now_ms - 2_000).expect("recent prompt");
        let rewound = std::time::Instant::now().duration_since(recent).as_millis();
        assert!(
            (1_500..).contains(&rewound),
            "the anchor rewinds to the prompt: {rewound}ms"
        );
        let old = SessionUi::loader_anchor_instant(now_ms - 90_000_000).expect("25-hour prompt");
        let rewound = std::time::Instant::now().duration_since(old).as_millis();
        assert!(
            (89_000_000..).contains(&rewound),
            "a 25h-old prompt keeps its anchor: {rewound}ms"
        );
        assert!(SessionUi::loader_anchor_instant(now_ms + 10_000).is_none());
        // A placeholder-era timestamp anchors at its own wall time (the
        // elapsed reads the wire's garbage, as in TS).
        let placeholder = SessionUi::loader_anchor_instant(1).expect("placeholder anchors");
        let rewound = std::time::Instant::now()
            .duration_since(placeholder)
            .as_millis();
        assert!(
            rewound > u128::from(now_ms - 10_000),
            "the placeholder anchors at its wall time, not the re-attach instant: {rewound}ms"
        );
    }
}
