//! Interactive agent session over the daemon: attach to a live session, send
//! prompts, render streamed assistant output, and switch sessions. This is
//! the interactive product surface of `crates/pa-tui` (the port of the
//! interactive mode's daemon-attach path); the session loop itself keeps
//! running in the daemon worker, so closing the UI detaches instead of
//! stopping the session.
//!
//! Two UI sources drive the same loop: a crossterm terminal (raw mode, alt
//! screen) and a headless plan (programmatic input, captured frames). The
//! headless source is the verifier seam: it exercises the identical
//! attach/submit/stream/render path without a TTY.

use std::collections::VecDeque;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

use crate::daemon_client::DaemonClient;
use crate::daemon_client::DaemonClientEvent;
use crate::exit_guard::ExitGuard;
use crate::keybindings::KeybindingsManager;
use crate::session_ui::SessionUi;
use crate::view::{AgentView, FlushPlan};

use crossterm::event::KeyEvent;
use crossterm::terminal;
use ratatui::Terminal;
use tokio::sync::mpsc;

/// The in-flight reconnect attempt's connect leg: a spawned task's
/// bounded `DaemonClient::connect_with_retry` result (fresh client plus
/// its event receiver), reported back to the interactive loop through a
/// oneshot.
type ReconnectConnect = tokio::sync::oneshot::Receiver<
    anyhow::Result<(DaemonClient, mpsc::UnboundedReceiver<DaemonClientEvent>)>,
>;

/// Cap on the exit-path telemetry flush: the PostHog sink alone allows up
/// to 1.5s, so the exit event must be dropped rather than awaited past the
/// exit-within-1s contract.
const TELEMETRY_EXIT_TIMEOUT_MS: u64 = 500;

/// Which session the interactive run opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionSelection {
    /// Create a fresh session (`create`, then `attach`).
    New,
    /// Attach an existing live session by active session id.
    Attach(String),
    /// Create with `sessionPath`: reopen a saved session file (`--resume`).
    Resume(PathBuf),
}

/// Explicit model selection carried into every `create` config: the CLI
/// `--provider`/`--model`/`--api-key`/`--thinking` flags. Explicit flags are
/// authoritative end-to-end — the daemon worker resolves its session model
/// and thinking level from this selection instead of a process-wide fallback.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelSelection {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    /// The requested thinking level (`--thinking`). The worker clamps it to
    /// the model's supported levels and records the effective level.
    pub thinking: Option<pa_types::ai::ModelThinkingLevel>,
}

/// Adoption telemetry for interactive-view interactions (schema v1 events
/// `tui scroll used`, `tui selection used`, and `tui exit`). pa-tui stays
/// pa-types-only, so the
/// composition root implements this against the telemetry client.
/// The seam is object-safe (held as `Arc<dyn InteractionTelemetry>` in the
/// options and session UI), so the async methods return boxed futures with an
/// explicit `Send` bound instead of RPITIT.
pub trait InteractionTelemetry: Send + Sync {
    /// The first transcript scroll action of a run: `action` is
    /// `page_up` / `page_down` / `top` / `follow`.
    fn scroll_used(
        &self,
        action: &'static str,
        resumed_following: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// The run's first selection copy (`tui selection used`): `lines` is
    /// the copied text's line count.
    fn selection_used(&self, lines: usize) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// A builtin client command was submitted (`agent command used`):
    /// `command` is the canonical name (`model`, `effort`, ...). Session
    /// commands report through the session telemetry instead.
    fn command_used(&self, command: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// How the client run ended: `reason` is `ctrl_c_twice` / `ctrl_d` /
    /// `session_request` / `daemon_closed`, with whether a turn was still
    /// active at exit.
    fn client_exit(
        &self,
        reason: &'static str,
        turn_active: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// The subagent summary line opened the scoped agents view (`tui
    /// subagents open`): `children_total` is the live descendant count at
    /// open time.
    fn subagents_view_opened(
        &self,
        children_total: u64,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// An actionable activity group was opened; never includes command or goal text.
    fn activity_opened(&self, kind: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// A menu surface opened (event `tui menu opened`): `menu` names the
    /// surface (`model`, `mcp`), `source` how it opened (`command` — the
    /// bare slash submission, `tab` — a typed partial + Tab).
    fn menu_opened(
        &self,
        menu: &'static str,
        source: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// An image was pasted into the editor from the clipboard (event
    /// `tui image pasted`); `mime_type` is the attachment's sniffed format.
    fn image_pasted(&self, mime_type: &str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// A submission parked in the follow-up queue behind a running turn:
    /// `lane` is `steering` (Enter) / `follow_up` (the follow-up key);
    /// `steering_mode` is the session's queue delivery mode (TS
    /// `steeringMode`: `all` = batched delivery at the boundary,
    /// `one-at-a-time` = one steer per turn).
    fn queued_input(
        &self,
        lane: &'static str,
        steering_mode: String,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// A parked message was edited through the queue browse (event
    /// `tui queue edited`): `action` is `select` (a browse opened a
    /// selection), `edit` (the edited text re-queued; empty text
    /// deletes), `delete`, or `reorder` (ctrl+alt+arrow). Never carries
    /// the message text.
    fn queue_edited(&self, action: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// The run's first `app.suspend` cycle (`tui suspend used`): `outcome`
    /// is `resumed` (the SIGCONT continuation restored the terminal) /
    /// `failed` (the cycle errored).
    fn suspend_used(&self, outcome: &'static str) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// The terminal enhanced-key modes settled (`tui enhanced keys`):
    /// `kitty` / `modify_other_keys` report the established combination.
    fn enhanced_keys(
        &self,
        kitty: bool,
        modify_other_keys: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// The terminal hyperlink (OSC 8) capability resolved for the run
    /// (event `tui hyperlinks`): `enabled` reports whether clickable link
    /// rendering is active.
    fn hyperlinks_active(&self, enabled: bool) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// The `!`/`!!` bash shortcut ran a command from the chat view (event
    /// `tui bash shortcut used`): `excluded` is the `!!` variant, and
    /// `side_conversation` marks a run inside a side-question pane.
    fn bash_shortcut_used(
        &self,
        excluded: bool,
        side_conversation: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// A dispatched bang run settled (event `tui bash bang executed`):
    /// `duration_bucket` is `lt_5s` / `5_to_30s` / `30s_plus` /
    /// `unknown`, `exit_class` is `zero` / `nonzero` / `cancelled` /
    /// `failed` / `unknown` — primitives only.
    fn bash_bang_executed(
        &self,
        duration_bucket: &'static str,
        exit_class: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
    /// A prompt-stash transition (`tui prompt stash`): `action` is
    /// `agents_view` / `session_switch` (a draft stashed on the way out)
    /// or `restored` (a stashed draft returned to the editor);
    /// `had_images` reports whether the draft carried pasted images.
    fn prompt_stash(
        &self,
        action: &'static str,
        had_images: bool,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

/// Persistence for the first-run onboarding answers. The TUI crate owns
/// only the surface; the composition root (pa-cli) implements the sink
/// against the settings manager, keeping pa-tui decoupled from pa-core.
pub trait OnboardingSink: Send + Sync {
    /// The persisted trace-sharing answer (TS `getAgentTracesEnabled`).
    fn agent_traces_enabled(&self) -> bool;
    /// Persist the trace-sharing answer (TS `setAgentTracesEnabled`).
    fn set_agent_traces_enabled(&self, enabled: bool) -> anyhow::Result<()>;
    /// Mark the onboarding flow completed (TS `markOnboardingShown` +
    /// `flush`); an aborted flow leaves the flag unset.
    fn mark_onboarding_complete(&self) -> anyhow::Result<()>;
}

/// The first-run flow to run before the session screen (TS
/// `runStartupOnboarding`, model-ready branch: splash + trace question).
#[derive(Clone)]
pub struct OnboardingTask {
    pub sink: std::sync::Arc<dyn OnboardingSink>,
}

impl std::fmt::Debug for OnboardingTask {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OnboardingTask").finish()
    }
}

/// Options for one interactive run. `Debug` skips the telemetry handle (the
/// trait object is not `Debug`).
#[derive(Clone)]
pub struct InteractiveOptions {
    pub socket_path: PathBuf,
    pub cwd: PathBuf,
    /// The model catalog for the `/model` picker (a startup snapshot
    /// resolved by the composition root; pa-tui stays pa-types only, so
    /// the registry itself lives above this crate). The daemon's
    /// `get_model_catalog` refresh replaces it once it lands.
    pub model_catalog: Vec<pa_types::ai::Model>,
    /// Providers with configured auth for the picker's sign-in marking.
    pub model_configured_providers: std::collections::HashSet<String>,
    /// The settings recent-model list (`provider/id` keys, newest first).
    pub model_recent_models: Vec<String>,
    /// The settings default thinking level (the picker's effort seed for
    /// non-reasoning current models).
    pub default_thinking_level: Option<String>,
    /// Persistence directory for new sessions (`sessionDir` in the create
    /// config; defaults to the daemon's sessions dir when `None`).
    pub session_dir: Option<PathBuf>,
    /// Scripted faux-engine script path. Verification seam only; the product
    /// never sets it.
    pub script_path: Option<PathBuf>,
    /// Model flags to carry into the create config.
    pub model_selection: ModelSelection,
    /// Create without a session file (`--no-session`).
    pub no_session: bool,
    pub session: SessionSelection,
    /// Prompt sent immediately after attach (CLI message arguments).
    pub initial_message: Option<String>,
    /// The `terminal.showImages` setting, default true (TS `getShowImages`):
    /// whether image blocks render their metadata rows or the
    /// `[Image: ...]` placeholders.
    pub show_images: bool,
    /// The `terminal.fullscreenMouse` setting, default true (TS
    /// `getFullscreenMouse`): whether the fullscreen surface enables SGR
    /// mouse tracking and wheel-scrolls the transcript.
    pub fullscreen_mouse: bool,
    pub theme: String,
    /// The chat markdown fenced-code indent, resolved by the composition
    /// root from `markdown.codeBlockIndent` (TS `getCodeBlockIndent`;
    /// default two spaces).
    pub code_block_indent: String,
    /// The `/tree` selector's initial filter mode, resolved by the
    /// composition root from the `treeFilterMode` setting (default view).
    pub tree_filter_mode: String,
    /// The `branchSummary.skipPrompt` setting: `/tree` navigation skips the
    /// "Summarize branch?" question and navigates with no summary.
    pub branch_summary_skip_prompt: bool,
    /// Product version for the brand splash.
    pub version: String,
    /// Run the first-run onboarding flow before the session screen.
    pub onboarding: Option<OnboardingTask>,
    /// Telemetry opt-out (TS `telemetryDisabled`): `Some(true)` only when
    /// the invocation disabled telemetry; carried on create/attach so the
    /// daemon worker installs no telemetry subscriber and attach obeys the
    /// TS `assertTelemetryAttachAllowed` guard.
    pub telemetry_disabled: Option<bool>,
    /// `/mcp login` / `/mcp logout`: the client-side auth flows the
    /// composition root provides (they drive the inline auth panel).
    /// `None` reports the commands as unavailable.
    pub client_auth: Option<crate::client_auth::ClientAuthCommandsHandle>,
    /// `/traces`: the settings + credential state the composition root
    /// owns (the trace upload subsystem itself stays unported). `None`
    /// reports the command as unavailable.
    pub traces: Option<crate::traces::TracesCommandsHandle>,
    /// `/login` + `/logout`: the provider auth flows (credential storage,
    /// OAuth, the provider catalog) the composition root owns. `None`
    /// reports the commands as unavailable.
    pub provider_auth: Option<crate::provider_auth::ProviderAuthCommandsHandle>,
    /// `/update`: the CLI child runner + the post-update relaunch the
    /// composition root owns. `None` reports the command as unavailable.
    pub update_commands: Option<crate::update_command::UpdateCommandsHandle>,
    /// Adoption telemetry for the interactive view; `None` drops events.
    pub telemetry: Option<std::sync::Arc<dyn InteractionTelemetry>>,
    /// The effective keybindings (defaults merged with the user's
    /// `keybindings.json`, loaded by the composition root; TS
    /// `KeybindingsManager.create()`): every hint and key handler renders
    /// and dispatches through this set.
    pub keybindings: KeybindingsManager,
    /// The client-owned prompt stash store shared across the chat views of
    /// this TUI process (TS `ClientPromptStashStore`): an editor draft
    /// left behind on a session switch returns when the session's chat
    /// reopens. The composition root owns one store per process, so the
    /// agents-view loop (view -> chat -> view) keeps every stashed draft.
    pub prompt_stash: std::sync::Arc<std::sync::Mutex<crate::prompt_stash::PromptStashStore>>,
    /// The attached session's persisted RLM depth (TS `sessionDepth`):
    /// the agents view passes it when it opens a row, and a subagent
    /// session renders its `depth N` tray label.
    pub session_rlm_depth: Option<u32>,
    /// Whether the opened session had direct children (TS
    /// `sessionHasChildren`).
    pub session_has_children: bool,
    /// The client-process settings the interactive commands read and
    /// persist (`/settings`, `/fullscreen`). The
    /// composition root implements the seam over the real store; `None`
    /// reports the commands' persistence as unavailable.
    pub client_settings: Option<std::sync::Arc<dyn crate::client_settings::ClientSettings>>,
}

impl std::fmt::Debug for InteractiveOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InteractiveOptions")
            .field("socket_path", &self.socket_path)
            .field("cwd", &self.cwd)
            .field("session_dir", &self.session_dir)
            .field("script_path", &self.script_path)
            .field("model_selection", &self.model_selection)
            .field("model_catalog", &self.model_catalog)
            .field("no_session", &self.no_session)
            .field("session", &self.session)
            .field("initial_message", &self.initial_message)
            .field("theme", &self.theme)
            .field("code_block_indent", &self.code_block_indent)
            .field("version", &self.version)
            .field("onboarding", &self.onboarding)
            .field("telemetry_disabled", &self.telemetry_disabled)
            .field("fullscreen_mouse", &self.fullscreen_mouse)
            .field("client_auth", &self.client_auth)
            .field("keybindings", &self.keybindings.get_effective_config())
            .finish()
    }
}

impl InteractiveOptions {
    /// The `create` config carried on every new-session request.
    pub(crate) fn create_config(&self) -> Value {
        let mut config = json!({ "cwd": self.cwd.display().to_string() });
        if let Some(session_dir) = &self.session_dir {
            config["sessionDir"] = json!(session_dir.display().to_string());
        }
        if let Some(script) = &self.script_path {
            config["script"] = json!(script.display().to_string());
        }
        if let Some(provider) = &self.model_selection.provider {
            config["provider"] = json!(provider);
        }
        if let Some(model) = &self.model_selection.model {
            config["model"] = json!(model);
        }
        if let Some(api_key) = &self.model_selection.api_key {
            config["apiKey"] = json!(api_key);
        }
        if let Some(thinking) = self.model_selection.thinking {
            config["thinking"] = json!(thinking.wire_name());
        }
        config
    }
}

/// How the UI is driven.
pub enum UiMode {
    /// Raw-mode terminal on stdout.
    Terminal,
    /// Headless plan: submitted prompts plus idle barriers, with rendered
    /// frames captured for assertions.
    Headless(HeadlessPlan),
}

/// A scripted headless run.
#[derive(Debug, Clone)]
pub struct HeadlessPlan {
    pub steps: Vec<HeadlessStep>,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone)]
pub enum HeadlessStep {
    /// Submit text (the same editor submit path as a user typing it).
    Submit(String),
    /// Type text character by character (raw editor input, so autocomplete
    /// and editor state react exactly as to a keystroke).
    Type(String),
    /// A bracketed-paste payload (the same editor paste path a terminal's
    /// paste takes, including the large-paste marker rules).
    Paste(String),
    /// Materialize the parked editor suggestions — the state a live user
    /// gets after pausing typing for one input-idle tick, so the next step
    /// (typically `Enter`) completes against the open dropdown. A burst of
    /// `Type` steps without this barrier submits as typed, exactly like a
    /// terminal keystroke burst.
    SettleIdle,
    /// Hold until the current turn finishes (bounded by `timeout_ms`).
    WaitIdle { timeout_ms: u64 },
    /// Hold the plan for `ms` before the next step: the verifier's timing
    /// window (queue prompts deterministically inside a scripted
    /// `delayMs` hold, where the turn is provably busy).
    WaitMs(u64),
    /// Scroll the transcript to its top row (the `tui.viewport.top` key
    /// path): the verifier's window into the head of the transcript.
    ScrollTop,
    /// A raw mouse sequence: decoded by the same parser the terminal's SGR
    /// reports flow through, so the verifier drives the wheel dispatch with
    /// byte-identical sequences.
    Mouse(String),
    /// One raw key event: the verifier's window into the selector/picker
    /// surfaces (arrows, escape), which typed text cannot express.
    Key(crossterm::event::KeyEvent),
}

/// One typed string as key events: characters become `Char` presses, `\n`
/// becomes Enter, and `\t` becomes Tab (the keys autocomplete reacts to).
fn typed_keys(text: &str) -> Vec<KeyEvent> {
    text.chars()
        .map(|c| match c {
            '\n' | '\r' => KeyEvent::new(
                crossterm::event::KeyCode::Enter,
                crossterm::event::KeyModifiers::NONE,
            ),
            '\t' => KeyEvent::new(
                crossterm::event::KeyCode::Tab,
                crossterm::event::KeyModifiers::NONE,
            ),
            other => KeyEvent::new(
                crossterm::event::KeyCode::Char(other),
                crossterm::event::KeyModifiers::NONE,
            ),
        })
        .collect()
}

/// Drive the onboarding pane until the trace question settles. Returns
/// `true` when the exit keys quit the app (TS `onExit` → shutdown).
async fn run_onboarding_phase(
    task: &OnboardingTask,
    view: &mut AgentView,
    ui_rx: &mut mpsc::UnboundedReceiver<UiInput>,
    renderer: &mut Renderer,
    exit_guard: &ExitGuard,
) -> Result<bool> {
    // Sharing is on unless the user opted out, so a fresh install always
    // takes this branch: the flow completes silently, nothing is drawn,
    // and the session screen owns the first frame. The question below
    // mounts only for a home that explicitly opted out before completing
    // onboarding (TS parity: `askOnboardingTraceOptIn` skips when already
    // enabled).
    if task.sink.agent_traces_enabled() {
        let _ = task.sink.mark_onboarding_complete();
        return Ok(false);
    }
    let mut screen = crate::onboarding::OnboardingScreen::new();
    let keybindings = view.editor.keybindings().clone();
    let mut exit_requested = false;
    loop {
        tokio::select! {
            maybe_input = ui_rx.recv() => {
                if let Some(UiInput::Key(key)) = maybe_input {
                    let Some(key_id) = crate::keys::key_event_to_id(&key) else {
                        continue;
                    };
                    // The onboarding exit keys include Ctrl+C (`app.clear`):
                    // report the handled press so the force-quit guard's
                    // handled counter stays in sync with the reader's
                    // observations.
                    if key_id == "ctrl+c" {
                        exit_guard.note_ctrl_c_handled();
                    }
                    match screen.handle_key(&key_id, &keybindings) {
                        Some(crate::onboarding::OnboardingDecision::Selected(index)) => {
                            // `Share` opts in; `Not now` keeps traces off
                            // (TS finish(index === 0)). A cancel writes no
                            // answer at all, but the flow still completed.
                            let _ = task.sink.set_agent_traces_enabled(index == 0);
                            let _ = task.sink.mark_onboarding_complete();
                            break;
                        }
                        Some(crate::onboarding::OnboardingDecision::Cancelled) => {
                            let _ = task.sink.mark_onboarding_complete();
                            break;
                        }
                        Some(crate::onboarding::OnboardingDecision::Exit) => {
                            exit_requested = true;
                            break;
                        }
                        None => {}
                    }
                }
            }
            // The field animates behind the flow panels until dismissal
            // (TS ANIMATION_INTERVAL_MS).
            _ = tokio::time::sleep(Duration::from_millis(120)) => {
                screen.tick();
            }
        }
        view.onboarding = Some(screen.clone());
        if let Some(renderer) = renderer.is_terminal_mut() {
            crate::app::draw(renderer, view)?;
        }
        view.onboarding = None;
    }
    if exit_requested {
        return Ok(true);
    }
    Ok(false)
}

/// Result of an interactive run: session identity plus, in headless mode, the
/// rendered frames.
#[derive(Debug, Clone, Default)]
pub struct InteractiveOutcome {
    pub active_session_id: String,
    pub session_id: String,
    /// The TS `formatResumeHint` line (a resumable, flushed session), for
    /// the composition root to print after the terminal is restored.
    pub resume_hint: Option<String>,
    pub last_assistant_text: Option<String>,
    pub frames: Vec<String>,
    /// OSC 52 clipboard sequences emitted during the run (headless capture
    /// only; terminal runs write them to stdout directly).
    pub clipboard_emissions: Vec<String>,
    /// `/resume` requested the agents view next (return-to-session flow).
    pub return_to_agents_view: bool,
    /// The subagent summary line opened the agents view scoped to this
    /// session's subtree; `None` with `return_to_agents_view` means the
    /// plain view.
    pub agents_view_scope: Option<crate::agents_view::AgentsViewScope>,
    /// `/resume <selector>` requested this session next.
    pub selection_request: Option<SessionSelection>,
    /// Texts copied out by finished mouse selections (headless runs have
    /// no terminal for OSC 52; the verifiers read these).
    pub copies: Vec<String>,
    /// A startup attach failed on a session that is truly gone: the run
    /// hands off to the agents view (`return_to_agents_view`) and this
    /// notice seeds the view's status line instead of the pane dying to
    /// the shell.
    pub agents_view_notice: Option<String>,
}

/// Inputs consumed by the UI loop. Terminal keys arrive one event at a time;
/// headless steps arrive as whole submissions.
enum UiInput {
    Key(KeyEvent),
    Paste(String),
    /// A decoded mouse report (wheel turns; other reports are consumed at
    /// the source).
    Mouse(crate::mouse::MouseEvent),
    Submit(String),
    /// One materialized input-idle tick (the headless `SettleIdle` step).
    SettleIdle,
    WaitIdle {
        timeout_ms: u64,
    },
    ScrollTop,
    /// The terminal was resized: the next draw repaints the new geometry.
    Resize,
    HeadlessDone,
}

/// TS `TUI.MIN_RENDER_INTERVAL_MS`: the frame scheduler's minimum spacing
/// between renders (every state change in the window coalesces into the
/// next frame, capping the render rate at ~60fps however fast the stream
/// delivers).
const MIN_RENDER_INTERVAL: Duration = Duration::from_millis(16);
/// The spinner's wall-clock cadence (TS `Loader` `DEFAULT_INTERVAL_MS`):
/// the animation phase advances one frame per 80ms of animating time
/// regardless of the render rate.
const SPINNER_INTERVAL_MS: u128 = 80;
/// Spec §10.2: the client reconnect window after an update restart
/// (10 minutes).
const RECONNECT_WINDOW: Duration = Duration::from_mins(10);

/// One reconnect attempt's reattach budget: a queued attach can legitimately
/// wait out a slow restore (§10.4), so the attempt hands back to the loop
/// instead of wedging the UI.
const RECONNECT_ATTACH_TIMEOUT_S: u64 = 30;
/// The reconnect backoff cap.
const RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(10);

/// TS `DAEMON_RECONNECT_TIMEOUT_MS`: the bounded session-plane reconnect
/// window after the direct worker link dies.
const SESSION_RECONNECT_WINDOW: Duration = Duration::from_mins(1);
/// TS reconnect backoff cap (`min(2000, 100 * 2 ** min(attempt, 5))`).
const SESSION_RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(2);
/// One re-attach attempt's budget: the attach carries its own request
/// timeouts; this bounds a wedged attempt so the loop reschedules instead
/// of blocking the UI.
const SESSION_RECONNECT_ATTEMPT_TIMEOUT_S: u64 = 10;

/// The interactive loop's session re-attach driver (TS
/// `DaemonAgentConnection.reconnect` over a direct-transport loss): the
/// worker process behind the direct link died, so the attach retries
/// through the supervisor — which respawns the worker and hands out a
/// fresh peer ticket — with the TS backoff inside the TS window.
struct SessionReconnect {
    active_session_id: String,
    deadline: tokio::time::Instant,
    next_attempt: tokio::time::Instant,
    delay: Duration,
    last_error: String,
}

impl SessionReconnect {
    fn start(active_session_id: &str) -> Self {
        SessionReconnect {
            active_session_id: active_session_id.to_string(),
            deadline: tokio::time::Instant::now() + SESSION_RECONNECT_WINDOW,
            next_attempt: tokio::time::Instant::now(),
            delay: Duration::from_millis(100),
            last_error: String::new(),
        }
    }

    /// The next attempt with doubling backoff (capped).
    fn next_attempt(mut self) -> Self {
        self.delay = (self.delay * 2).min(SESSION_RECONNECT_BACKOFF_MAX);
        self.next_attempt = tokio::time::Instant::now() + self.delay;
        self
    }
}

/// The interactive loop's reconnect driver (spec §10.2): attempts with
/// doubling backoff inside the 10-minute window; the user can leave with
/// Ctrl+C at any point (UI input keeps flowing through the same loop).
/// The same driver also serves an UNEXPECTED connection loss (the
/// supervisor connection died mid-run with no update in flight — a daemon
/// hiccup at load, 2026-09-24: the one-shot path exited the operator's
/// TUI with "the daemon connection closed"): the pane keeps its
/// transcript and editor and retries instead of dying.
struct ReconnectLoop {
    deadline: tokio::time::Instant,
    next_attempt: tokio::time::Instant,
    delay: Duration,
    /// Whether this driver serves an unexpected loss (the expiry and
    /// failure notes name it, not an update restart).
    lost: bool,
}

impl ReconnectLoop {
    fn start(_update: &crate::daemon_client::DaemonClosingUpdate) -> Self {
        let delay = Duration::from_secs(1);
        ReconnectLoop {
            deadline: tokio::time::Instant::now() + RECONNECT_WINDOW,
            next_attempt: tokio::time::Instant::now() + delay,
            delay,
            lost: false,
        }
    }

    /// The unexpected-loss variant: same window, same backoff, its own
    /// expiry note.
    fn start_lost() -> Self {
        let delay = Duration::from_secs(1);
        ReconnectLoop {
            deadline: tokio::time::Instant::now() + RECONNECT_WINDOW,
            next_attempt: tokio::time::Instant::now() + delay,
            delay,
            lost: true,
        }
    }

    /// The next attempt with doubling backoff (capped).
    fn next_attempt(mut self) -> Self {
        self.delay = (self.delay * 2).min(RECONNECT_BACKOFF_MAX);
        self.next_attempt = tokio::time::Instant::now() + self.delay;
        self
    }
}

/// Run the interactive UI until the user exits (terminal) or the plan
/// completes (headless).
///
/// Every error return funnels through the one exit restore: an early `?`
/// between the surface mount and the deliberate tail teardown (a draw
/// failure, a key-handler transport error, a suspend/resume failure)
/// must not hand the shell a terminal still in TUI state — raw mode,
/// the alternate screen, the enhancement modes armed. The restore is
/// idempotent, so a return after the tail already ran (the startup
/// refusal path finishes the surface itself) only re-emits the two
/// unconditional tail bytes.
pub async fn run_interactive(
    options: InteractiveOptions,
    ui: UiMode,
) -> Result<InteractiveOutcome> {
    // The headless harness drives the same dispatch on plain pipes: it
    // never owned the terminal, so its error returns must not run a
    // restore (the mode gates it — the distinction the headless e2e
    // binaries observe, not `restore_terminal`'s pipe no-op).
    let owns_terminal = matches!(ui, UiMode::Terminal);
    // A terminal-mode error that fired BEFORE this surface mounted (the
    // daemon connection refused at the top) must not tear down whatever
    // the CALLER had up: the restore runs only once this run's surface
    // actually mounted.
    let surface_mounted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mounted = std::sync::Arc::clone(&surface_mounted);
    match run_interactive_surface(options, ui, mounted).await {
        Ok(outcome) => Ok(outcome),
        Err(error) => {
            // Restore when THIS run changed the terminal state (the flag
            // arms at the raw-mode entry inside `Renderer::setup`) OR
            // when it entered on a pane already in TUI state (the
            // agents-view preserve handoff: the adopting surface owns the
            // release even when it fails before mounting — the process is
            // exiting and no other writer remains). A fresh-pane
            // pre-mount failure (the daemon refused the connect) has
            // nothing to release and must not tear down the caller.
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

async fn run_interactive_surface(
    options: InteractiveOptions,
    ui: UiMode,
    surface_mounted: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<InteractiveOutcome> {
    // The TS theme emits raw ANSI color codes regardless of NO_COLOR; match
    // that so the same terminal renders the same frames either way.
    crossterm::style::force_color_output(true);
    let (client, mut events) = DaemonClient::connect_with_retry(&options.socket_path)
        .await
        .with_context(|| "the interactive UI could not attach to the daemon")?;
    // Background notes (a failed abort request) fold into the transcript
    // through the same loop that renders daemon events.
    let (notes_tx, mut notes_rx) = mpsc::unbounded_channel::<String>();
    // The backgrounded compaction abort reports here; the loop folds a
    // failed abort into the transcript note and clears the stuck loader.
    let (compaction_abort_tx, mut compaction_abort_rx) =
        mpsc::unbounded_channel::<crate::session_ui::CompactionAbortNote>();
    // The `/share` upload task reports here; the loop folds the outcome
    // into the transcript and clears the loader.
    let (share_tx, mut share_rx) = mpsc::unbounded_channel::<crate::session_ui::ShareNote>();
    // The `/reload` task reports here; the loop folds the client-side
    // re-reads (keybindings, theme) and the outcome row.
    let (reload_tx, mut reload_rx) = mpsc::unbounded_channel::<crate::session_ui::ReloadNote>();
    // The `/traces upload-all` sweep reports here; the loop folds the live
    // progress into the status row and the settled summary.
    let (traces_upload_tx, mut traces_upload_rx) =
        mpsc::unbounded_channel::<crate::session_ui::TracesUploadNote>();
    // The background model-catalog refresh (`get_model_catalog`) reports
    // here; the loop folds it into the picker catalog and any open picker.
    let (catalog_tx, mut catalog_rx) =
        mpsc::unbounded_channel::<crate::session_ui::ModelCatalogUpdate>();
    // Background heartbeat-catalog refreshes (`heartbeats_list` for an
    // open `/heartbeats` view) report here; the loop folds them into the
    // open view.
    let (heartbeats_tx, mut heartbeats_rx) =
        mpsc::unbounded_channel::<crate::session_ui::HeartbeatsUpdate>();
    // The inline auth panel's login flows drive the panel through this
    // channel (progress lines, the URL block, prompts, the team picker,
    // and each flow's settled outcome); the loop owns the receiving side
    // and folds every request into the mounted panel.
    let (auth_panel_tx, mut auth_panel_rx) =
        mpsc::unbounded_channel::<crate::auth_panel::AuthPanelRequest>();
    let (bash_tx, mut bash_rx) = mpsc::unbounded_channel::<crate::session_ui::BashActivityUpdate>();
    // Background slash-command-catalog refreshes (`get_commands`) report
    // here; the loop folds the session's skill commands into the
    // autocomplete provider.
    let (commands_tx, mut commands_rx) =
        mpsc::unbounded_channel::<crate::session_ui::CommandCatalogUpdate>();
    // The double-Ctrl+C force-quit guard: the terminal reader observes the
    // pair even while this loop is wedged in a daemon request, and a plain
    // std-thread watchdog enforces the exit deadline without the runtime.
    let exit_guard = ExitGuard::new();

    // The view and the terminal surface come up BEFORE the session attach
    // (TS `init`: `ui.start()` paints the header + editor first, then
    // `rebindCurrentSession` loads the session; the header's model and cwd
    // lines fill in when the connection state loads). The pane paints the
    // startup chrome immediately instead of holding the previous surface
    // (or a blank pane) until the attach snapshot arrives; the transcript
    // itself renders when the snapshot lands — `rebuild_view`'s dirty flag
    // schedules the first full repaint, so no resize event is ever needed
    // to see the attached session.
    let theme = crate::app::load_theme(&options.theme);
    let mut view = AgentView::new(theme);
    view.code_block_indent = options.code_block_indent.clone();
    // The effective bindings (user `keybindings.json` merged over the TS
    // defaults) drive the editor, the pickers, and every hint the view
    // renders (TS `KeybindingsManager.create()` + `setKeybindings`).
    view.editor.set_keybindings(options.keybindings.clone());
    // The `terminal.showImages` setting rides the startup options (TS
    // `getShowImages`), resolved by the composition root.
    view.show_images = options.show_images;
    // The persisted `terminal.fullscreen` preference seeds the runtime
    // toggle (TS `fullscreenEnabled`); the compose gates the top bar on it.
    if let Some(settings) = &options.client_settings {
        view.fullscreen = settings.fullscreen();
    }
    apply_startup_chrome(&mut view, &options);
    let (ui_tx, mut ui_rx) = mpsc::unbounded_channel::<UiInput>();
    // Headless verification runs capture the OSC 52 clipboard channel
    // instead of writing it to the plain pipes.
    let headless = matches!(ui, UiMode::Headless(_));
    // A panic anywhere between the mount below and the deliberate
    // teardown must still hand the terminal back whole: the unwind guard
    // fires the one exit restore while the frame is dying (a set_hook
    // cannot carry this — tokio catches task panics and the process
    // would live on with a half-restored surface).
    let _surface_restore = crate::exit_restore::SurfaceRestore::armed();
    let mut renderer = Renderer::setup(
        ui,
        ui_tx,
        exit_guard.clone(),
        options.fullscreen_mouse,
        &surface_mounted,
    )?;
    if !headless {
        // TS `ui.start()` renders once before the session loads: the first
        // frame is the startup chrome (banner, editor, tray). The model
        // and session labels are placeholders until the attach's
        // `rebuild_view` repaints with the snapshot.
        if let Some(renderer) = renderer.is_terminal_mut() {
            crate::app::draw(renderer, &mut view)?;
        }
    }
    // The supervisor reader's death watch: the event channel itself stays
    // open across a supervisor socket loss (the retained sender keeps it
    // alive for direct reader pumps), so this watch is the observable
    // signal the loop's reconnect driver arms on.
    let mut reader_dead = client.reader_dead();
    let mut session = match SessionUi::open(
        client,
        &options,
        notes_tx,
        compaction_abort_tx,
        share_tx,
        reload_tx,
        traces_upload_tx,
        catalog_tx,
        auth_panel_tx,
        crate::session_ui::ActivityUpdates {
            heartbeats: heartbeats_tx,
            bash: bash_tx,
            commands: commands_tx,
        },
    )
    .await
    {
        Ok(session) => session,
        Err(error) => {
            // A daemon refusal for the startup create/attach/resume (the
            // daemon is alive and refused THIS request — a remembered id
            // whose worker is gone, or a saved-session create the daemon
            // refuses, e.g. "Session is already active in <id>" while
            // another instance holds the session file): the pane hands off
            // to the agents view with the failure as its status line —
            // the session-picker fallback — instead of dying to the
            // shell. Only transport/protocol failures (daemon down,
            // unanswerable socket) stay fatal.
            //
            // The unknown-session check matches the daemon's RAW refusal
            // message exactly - it must name this attach's own selector -
            // so a selector that happens to contain the phrase could not
            // forge the refusal (and vice versa).
            let unknown_session_refusal = |selector: &str| {
                let expected = format!("Unknown active session: {selector}");
                error.chain().any(|cause| {
                    cause
                        .downcast_ref::<crate::daemon_client::RequestRejected>()
                        .is_some_and(|rejection| rejection.message == expected)
                })
            };
            if let SessionSelection::Attach(selector) = &options.session {
                if unknown_session_refusal(selector) {
                    // The handoff keeps the process alive: disarm the
                    // double-Ctrl+C force-quit watchdog like the normal
                    // agents-view handoff does.
                    exit_guard.cancel();
                    let frames = renderer.finish(&mut view, true);
                    return Ok(InteractiveOutcome {
                        return_to_agents_view: true,
                        agents_view_notice: Some(format!(
                            "Session {selector} is no longer running — pick a session to continue."
                        )),
                        frames,
                        ..Default::default()
                    });
                }
            }
            // A response/handshake timeout (the daemon alive but slow at
            // load: "Timed out after Nms waiting for the Prime Agent daemon
            // response") is a hiccup, not a protocol failure: the same
            // session-picker fallback, never a fatal exit that loses the
            // user's pane (operator directive 2026-09-24 — the attach
            // timeout at box load exited the TUI).
            if crate::daemon_client::is_daemon_timeout(&error) {
                exit_guard.cancel();
                let frames = renderer.finish(&mut view, true);
                return Ok(InteractiveOutcome {
                    return_to_agents_view: true,
                    agents_view_notice: Some(format!("{error:#} — pick a session to continue.")),
                    frames,
                    ..Default::default()
                });
            }
            // Any other daemon refusal (a create the daemon refused for a
            // saved-session open, an admission refusal, ...) gets the same
            // session-picker fallback: the agents view opens with the
            // refusal as its status line and the client never exits.
            if crate::daemon_client::is_daemon_rejection(&error) {
                exit_guard.cancel();
                let frames = renderer.finish(&mut view, true);
                return Ok(InteractiveOutcome {
                    return_to_agents_view: true,
                    agents_view_notice: Some(format!("{error:#}")),
                    frames,
                    ..Default::default()
                });
            }
            // The surface is already up: hand the terminal back before the
            // CLI reports the failure on the plain screen (the same
            // teardown contract as the onboarding exit below).
            if renderer.is_terminal() {
                exit_guard.arm_for_exit();
            }
            renderer.finish(&mut view, false);
            return Err(error);
        }
    };
    session.exit_guard = exit_guard.clone();
    if headless {
        session.osc_sink = crate::clipboard::OscSink::Buffer(Vec::new());
    }
    session.refresh_stats().await;
    // The startup catalog fetch (TS `updateAvailableProviderCount` →
    // `getConnectionAvailableModels`): failures stay silent and the
    // composition-root snapshot keeps serving the picker.
    session.spawn_model_catalog_refresh();
    // The scoped heartbeat catalog seeds the tray heartbeat label (TS
    // refreshes the catalog on chat open; failures stay silent).
    session.spawn_heartbeat_refresh();
    session.spawn_bash_activity_refresh();
    session.rebuild_view(&mut view, crate::session_ui::RebuildKind::Rebind);
    if let Some(notice) = check_tmux_keyboard_setup().await {
        view.push_entry(crate::chat::ChatEntry::Status {
            text: format!("\u{26a0} {notice}"),
            kind: crate::chat::StatusKind::Warning,
        });
        session.dirty = true;
    }
    // TS `restorePromptStashOnOpen`: a draft stashed on the way out (a
    // previous chat view of this session left via the agents view or a
    // switch) returns to the editor when its chat reopens.
    session.restore_prompt_stash_on_open(&mut view);
    // First-run onboarding owns the pane before the session screen (TS
    // `runStartupOnboarding`, model-ready branch). A fresh install ships
    // trace sharing pre-configured, so this completes silently without
    // drawing; only an explicit opt-out that never completed onboarding
    // mounts the splash + trace question.
    if let Some(task) = options.onboarding.clone() {
        let exit_requested =
            run_onboarding_phase(&task, &mut view, &mut ui_rx, &mut renderer, &exit_guard).await?;
        if exit_requested {
            // The exit deadline is armed from the moment the run decides to
            // leave: no cleanup below may block past it.
            exit_guard.arm_for_exit();
            session.detach_for_exit().await;
            // The user quit at the onboarding screen: still hand the
            // terminal back (raw mode off, alt screen left and flushed)
            // exactly like a session exit.
            renderer.finish(&mut view, false);
            return Ok(InteractiveOutcome {
                active_session_id: session.active_session_id.clone(),
                session_id: session.session_id.clone(),
                resume_hint: None,
                last_assistant_text: None,
                frames: Vec::new(),
                clipboard_emissions: Vec::new(),
                agents_view_scope: None,
                // Onboarding exit leaves no session open; no return-to-view
                // or pending selection applies.
                return_to_agents_view: false,
                selection_request: None,
                copies: Vec::new(),
                agents_view_notice: None,
            });
        }
    }
    if let Some(initial) = &options.initial_message {
        session
            .submit_prompt(initial, crate::session_ui::SubmitBehavior::Steer, &mut view)
            .await?;
    }

    let mut pending: VecDeque<UiInput> = VecDeque::new();
    let mut last_bash_refresh = Instant::now();
    // The enhanced-key modes settle once (kitty answer or fallback) and
    // report one adoption event; headless runs hold pipes and never probe.
    let mut enhanced_keys_pending = renderer.is_terminal();
    // The hyperlink capability is env-based and settles at run start (no
    // probe round-trip like the kitty keyboard protocol); terminal runs
    // report it once alongside the enhanced-key modes.
    let mut hyperlinks_pending = renderer.is_terminal();
    // The frame scheduler (TS `requestRender` + `scheduleRender`): state
    // changes coalesce, and the loop paints at most one frame per
    // MIN_RENDER_INTERVAL_MS. `last_render_at` is `None` before the first
    // frame, `render_deadline` is armed while a dirty frame waits out the
    // interval.
    let mut last_render_at: Option<Instant> = None;
    let mut render_deadline: Option<Instant> = None;
    let mut anim_started: Option<Instant> = None;
    // The spinner phase painted by the last frame (`usize::MAX` before the
    // first): a quiet turn only dirties when the 80ms phase advances, not
    // on every loop tick.
    let mut last_pulse_phase: usize = usize::MAX;
    // Whether the Ctrl+C exit hint painted a frame that the expiry must
    // clear (TS `showCtrlCExitHint`'s timer repaints it away; without the
    // flag the loop cannot tell an armed hint from one that just
    // expired between iterations).
    let mut hint_painted = false;
    let mut running = true;
    let mut headless_done = false;
    let mut wait_idle_deadline: Option<Instant> = None;
    // Spec §10.2: the reconnect loop after a `daemon_closing` update frame.
    // Retry with backoff for up to RECONNECT_WINDOW; each attempt reads the
    // successor's hello (`update_resume`, §10.3) and reattaches by durable
    // session id (§10.4 - the supervisor queues the attach behind any
    // restore still in flight). UI input keeps flowing while reconnecting,
    // so the user can leave with Ctrl+C instead of riding out the window.
    let mut reconnect: Option<ReconnectLoop> = None;
    // The in-flight reconnect attempt's connect leg (spawned off the loop,
    // so the attempt's connect+hello wait never blocks UI input or the
    // render; the reattach leg runs inline on the loop under its own
    // bound).
    let mut reconnect_connect: Option<ReconnectConnect> = None;
    // Mirrors `reconnect_connect`'s in-flight state as a plain copy so the
    // tick arm's future can park without borrowing the attempt receiver
    // (the attempt arm owns its mutable borrow).
    let mut reconnect_attempt_in_flight = false;
    // The reader-death watch is one-shot: once the loss is handled (or
    // suppressed behind a live direct link), the arm parks so the closed
    // watch cannot hot-spin the select loop.
    let mut reader_loss_handled = false;
    // The supervisor connection died while a live direct link kept serving
    // the session: the loss is retained (not recovered — replacing the
    // client would churn the working link) until the direct link itself
    // dies; then the full reconnect driver owns the recovery instead of
    // the session-plane retry loop, which would ride a dead supervisor.
    let mut supervisor_lost = false;
    // Set once the event channel has returned None (a closed connection's
    // recv() resolves None instantly and forever — see the events arm).
    let mut events_closed = false;
    // The session re-attach driver: armed when the direct worker link dies
    // (a killed or crashed worker); it re-attaches through the supervisor
    // so the respawned worker serves the session again.
    let mut session_reconnect: Option<SessionReconnect> = None;

    while running {
        // The enhanced-key modes settle once per run: the kitty probe
        // answered, or the modifyOtherKeys fallback fired. One adoption
        // event reports the established combination.
        if enhanced_keys_pending {
            if let Some((kitty, modify_other_keys)) = crate::enhanced_keys::settle_state() {
                if let Some(telemetry) = &session.telemetry {
                    telemetry.enhanced_keys(kitty, modify_other_keys).await;
                }
                enhanced_keys_pending = false;
            }
        }

        // The OSC 8 hyperlink capability settles once per run with the
        // terminal identity the paint backend binds to: one adoption event
        // reports the gate (`tui hyperlinks`). The one-shot client's
        // flush shutdown can wait out a slow telemetry endpoint, so the
        // event is spawned instead of awaited - the run's first frame and
        // input handling never block on it.
        if hyperlinks_pending {
            if let Some(telemetry) = session.telemetry.clone() {
                let enabled = crate::hyperlinks::hyperlinks_enabled();
                tokio::spawn(async move {
                    telemetry.hyperlinks_active(enabled).await;
                });
            }
            hyperlinks_pending = false;
        }

        // Drain the whole queued input batch in this one iteration (TS
        // `handleInput` dispatches every event of a stdin chunk, then
        // schedules one render): a burst of wheel turns or held keys
        // applies as one batch instead of one full-layout render pass per
        // event, and an exit key queued behind a burst lands in the same
        // batch — the loop never spends its cycles behind a backlog the
        // user cannot escape. A WaitIdle step is a barrier: it stays at the
        // head of the queue until the turn finishes (or its deadline),
        // holding everything queued behind it.
        let mut inputs_pending = !pending.is_empty();
        while inputs_pending {
            if let Some(UiInput::WaitIdle { timeout_ms }) = pending.front() {
                let timeout_ms = *timeout_ms;
                // A parked follow-up/steering message keeps the barrier waiting
                // until the session delivers it (the queue strip must clear
                // before the next step observes the frames).
                if session.turn_active || !view.queued.is_empty() {
                    if wait_idle_deadline.is_none() {
                        wait_idle_deadline =
                            Some(Instant::now() + Duration::from_millis(timeout_ms));
                    } else if Instant::now() > wait_idle_deadline.unwrap() {
                        wait_idle_deadline = None;
                        pending.pop_front();
                        session.note("timed out waiting for the turn to finish", &mut view);
                    }
                    // The barrier holds the batch: the queued inputs stay
                    // until the turn delivers them.
                    inputs_pending = false;
                } else {
                    wait_idle_deadline = None;
                    pending.pop_front();
                }
            } else if let Some(input) = pending.pop_front() {
                session.dirty = true;
                match input {
                    UiInput::Key(key) => {
                        // TS stops the selection auto-scroll on every
                        // non-mouse input (`handleFullscreenInput`).
                        session.stop_selection_auto_scroll();
                        match session.handle_key(key, &mut view, &mut running).await {
                            Ok(()) => {}
                            // A daemon refusal answered this key's request
                            // (the connection stays healthy): the TS
                            // `showError` row surfaces it and the loop keeps
                            // running with the editor state preserved — a
                            // refused request never exits the client.
                            Err(error) if crate::daemon_client::is_daemon_rejection(&error) => {
                                session.error_row(&format!("{error:#}"), &mut view);
                            }
                            // Everything else (dead socket, timeout,
                            // protocol corruption) stays fatal.
                            Err(error) => return Err(error),
                        }
                        // TS `handleCtrlZ` (`app.suspend`, default ctrl+z):
                        // hand the terminal to the shell and stop the process
                        // group; execution continues here once the user
                        // foregrounds the process (SIGCONT), where the cycle
                        // re-applies raw mode, the alt screen, and SGR mouse
                        // tracking (TS `ui.start()` + `applyFullscreen(true)`).
                        // Headless runs keep no terminal renderer (TS never
                        // registers the action without one), so the request is
                        // observed and dropped.
                        // A parked `/traces login` (or the enable arm's
                        // login-first step): mount the inline auth panel
                        // and spawn the flow (the panel channel carries
                        // its requests and the settled outcome).
                        if session.pending_traces_login() {
                            session.run_traces_login(&mut view);
                        }
                        // A `/update` run: the child processes own the plain
                        // terminal, and a successful self-update replaces this
                        // process with the updated CLI (never returns).
                        if session.pending_update() {
                            renderer.suspend(&mut view)?;
                            session.run_update(&mut view).await?;
                            renderer.resume()?;
                        }
                        if session.take_suspend_request() && renderer.is_terminal_mut().is_some() {
                            match crate::suspend::suspend_cycle(
                                &mut crate::suspend::ProcessSignals,
                                &mut TerminalHandoff {
                                    renderer: &mut renderer,
                                    view: &mut view,
                                },
                            ) {
                                Ok(()) => session.track_suspend_used("resumed"),
                                Err(error) => {
                                    session.track_suspend_used("failed");
                                    session.error_row(&format!("{error:#}"), &mut view);
                                    // Try to take the terminal back so the run
                                    // stays usable; if that also fails, the
                                    // draw below surfaces the broken frame.
                                    let _ = renderer.resume();
                                }
                            }
                        }
                        // The `/mcp` view resolved to an auth request (its
                        // Enter on a connection, or the pasteable service's
                        // paste flow): mount the inline auth panel and spawn
                        // the client auth command against it — the
                        // typed-command arg path is gone, so the view never
                        // resolves through a submitted `/mcp <args>`
                        // string, and no flow touches the terminal.
                        if session.pending_mcp_auth() {
                            session.run_mcp_auth(&mut view);
                        }
                    }
                    UiInput::Paste(text) => {
                        session.stop_selection_auto_scroll();
                        // The inline auth panel owns the frame: the paste
                        // lands in its field, never in the editor behind
                        // it.
                        if view.auth_panel.is_some() {
                            session.paste_to_auth_panel(&text, &mut view);
                        } else {
                            session.handle_paste(&text, &mut view);
                        }
                    }
                    // A mouse report reaches the transcript scroll dispatch
                    // (TS `handleFullscreenInput`'s wheel branch); non-wheel
                    // reports are consumed inside.
                    UiInput::Mouse(event) => {
                        session.handle_mouse(event, &mut view);
                    }
                    // The headless plan's pause step: the queued keystroke
                    // batch ahead of this barrier is fully handled, so the
                    // parked suggestions materialize now — the same state the
                    // terminal loop's 50 ms idle tick produces after a real
                    // user pauses typing.
                    UiInput::SettleIdle => {
                        session.materialize_editor_autocomplete(&mut view);
                    }
                    UiInput::Submit(text) => {
                        session.stop_selection_auto_scroll();
                        // No submitted text needs the terminal: the
                        // `/mcp` typed-arg form is gone (its login flow
                        // resolved through the view's own auth seam above).
                        let dispatched = session
                            .submit_prompt(
                                &text,
                                crate::session_ui::SubmitBehavior::Steer,
                                &mut view,
                            )
                            .await;
                        if let Err(error) = dispatched {
                            // TS: a rejected submission surfaces the `⚠ Error`
                            // row and keeps the client mounted with the draft
                            // restored — a failed prompt never exits the UI.
                            session.error_row(&format!("{error:#}"), &mut view);
                            view.editor.set_text(&text);
                            session.dirty = true;
                        }
                        // A `/update` run parked by the submission: the child
                        // processes own the plain terminal, and a successful
                        // self-update replaces this process (never returns).
                        if session.pending_update() {
                            renderer.suspend(&mut view)?;
                            session.run_update(&mut view).await?;
                            renderer.resume()?;
                        }
                        // A parked `/traces login` (or the enable arm's
                        // login-first step): mount the inline auth panel and
                        // spawn the flow (the Submit path needs the same
                        // dispatch the Key path has — headless plans drive
                        // commands as submissions).
                        if session.pending_traces_login() {
                            session.run_traces_login(&mut view);
                        }
                    }
                    UiInput::HeadlessDone => headless_done = true,
                    UiInput::ScrollTop => {
                        session.stop_selection_auto_scroll();
                        view.scroll_to_top();
                    }
                    UiInput::Resize => {
                        session.stop_selection_auto_scroll();
                        // The editor lays its window out against the new row
                        // count; the branch's dirty flag repaints the frame at
                        // the new geometry.
                        if let Ok((_width, height)) = crossterm::terminal::size() {
                            view.set_terminal_rows(height);
                        }
                    }
                    UiInput::WaitIdle { .. } => unreachable!("barrier handled above"),
                }
                // Paint the handled input in this iteration: the select below can
                // otherwise wait out its 50ms tick before the next draw, and
                // that wait is felt directly as keystroke-to-render lag.
                // A handoff paints nothing: the next surface owns the pane
                // (TS `returnToAgentsView` hands the terminal over without a
                // final repaint — the agents view's mount clears the alt
                // screen), so the chat's last layout is dead work that only
                // delays the switch.
                if let Some(renderer) = renderer.is_terminal_mut() {
                    if !session.open_agents_view && session.pending_selection.is_none() {
                        // The inline paint must reflect tray state the
                        // handled key just armed (the Ctrl+C exit hint:
                        // TS `showCtrlCExitHint` requestRender's on the
                        // key). The loop's refresh below the select only
                        // reaches the frame gate, and the inline paint
                        // clears `dirty` — an idle terminal would
                        // otherwise never show the armed hint.
                        view.chrome.tray_override = session.tray_override(&view);
                        crate::app::draw(renderer, &mut view)?;
                        // The frame scheduler's bookkeeping follows the
                        // inline paint: the 16ms gate below now measures its
                        // interval from this frame, and a paint satisfied
                        // any armed deadline.
                        last_render_at = Some(Instant::now());
                        last_pulse_phase = view.pulse_frame;
                        render_deadline = None;
                    }
                    session.dirty = false;
                }
                // An exit key must not wait out the select tick before the
                // bounded shutdown path runs.
                if !running {
                    break;
                }
                // `exit_requested` is the same leave-now signal (agents-back,
                // `/resume`, `/exit`): in terminal mode the teardown below must
                // run this iteration, not after the select's 50ms idle tick
                // parks the loop — that park reads directly as switch latency
                // (TS's event loop leaves on the key). Headless runs keep the
                // tail pass so captured frames stay identical.
                if session.exit_requested && renderer.is_terminal() {
                    session.exit_reason = "session_request";
                    break;
                }
                // Headless input keeps the one-step-per-iteration order the
                // plans were written against: every step renders before the
                // next applies (a plan step is not a terminal burst, and the
                // captured frame sequence IS the verifier evidence — a
                // batched drain would collapse intermediate states like the
                // quick-shortcut guide or the expanded compaction block out
                // of the capture). The terminal path keeps the full batch
                // drain, the input-starvation fix.
                if !renderer.is_terminal() {
                    inputs_pending = false;
                }
            } else {
                // The batch drained: everything queued was handled in this
                // one pass (TS dispatches a stdin chunk's events the same
                // way). Without this arm the drain loop would spin on the
                // empty queue — the select below would never run again,
                // starving every render and input after the first batch
                // (the trapped, 90%+ CPU state the dogfood hit).
                inputs_pending = false;
            }
        }
        // A `/share` upload in flight holds the run open like an active
        // turn: the headless harness must not finish before its outcome
        // rows land (a live terminal never ends the run on its own).
        if headless_done
            && pending.is_empty()
            && !session.turn_active
            && view.queued.is_empty()
            && wait_idle_deadline.is_none()
            && !session.dirty
            && !session.share_pending()
            && !session.reload_pending()
            && !session.traces_upload_pending()
            // An inline auth flow is work like an upload: the harness
            // must not finish before its settled outcome lands (a live
            // terminal never ends the run on its own).
            && view.auth_panel.is_none()
            && !session.pending_traces_login()
            && !session.pending_mcp_auth()
        {
            break;
        }

        let was_active = session.turn_active;
        tokio::select! {
            maybe_event = async {
                // A closed channel's recv() resolves None instantly and
                // forever; while the reconnect driver owns the run (§10.2)
                // that always-ready arm would hot-spin the loop and starve
                // the tokio timers (the reconnect tick, the frame
                // deadline). Park the arm instead: the tick drives the
                // retries until the successor connection replaces the
                // channel.
                if events_closed && reconnect.is_some() {
                    std::future::pending::<()>().await;
                }
                events.recv().await
            } => {
                match maybe_event {
                    Some(event) => {
                        session.apply_client_event(event, &mut view);
                        // Batch the rest of the queued frames before this
                        // iteration's render: a stream burst applies as one
                        // transcript pass instead of one full re-layout per
                        // frame (a replay-scale ingest renders once per
                        // batch, not once per row).
                        while let Ok(event) = events.try_recv() {
                            session.apply_client_event(event, &mut view);
                        }
                        // A succeeded compaction rebuilt the durable
                        // transcript: replace the view's chat with it, and
                        // refresh the tray usage the same way a settled
                        // turn does (TS refreshes after "a turn or
                        // compaction completes" — post-compaction usage is
                        // unknown until the next assistant response).
                        if session.transcript_stale {
                            session.rebuild_transcript(&mut view).await;
                            session.refresh_stats().await;
                            session.rebuild_tray(&mut view);
                        }
                        // A settled turn refreshes the tray's context usage.
                        if was_active && !session.turn_active {
                            session.refresh_stats().await;
                            session.rebuild_tray(&mut view);
                        }
                        // A `session_binding` supersede notice: the session
                        // lives under a new active id, so re-attach to it -
                        // event routing follows the attach, and the
                        // transcript rebuilds from the snapshot (silent, no
                        // banner). A failed re-attach changes nothing: the
                        // new attach never landed, so the pane keeps its
                        // current id and subscription (the old one detaches
                        // only after a new attach succeeds); the next
                        // supersede notice or the submit-path retry
                        // re-attaches once a worker can serve the session.
                        if let Some(current) = session.pending_rebind.take() {
                            match session.attach_session(&current).await {
                                Ok(()) => session.rebuild_view(
                                    &mut view,
                                    crate::session_ui::RebuildKind::Rebind,
                                ),
                                Err(error) => session.note(
                                    &format!("session rebind failed: {error:#}"),
                                    &mut view,
                                ),
                            }
                        }
                        // An update close frame arms the reconnect driver
                        // immediately: the doomed connection's reader task is
                        // gone, but the client struct retains an event
                        // sender, so the channel itself never closes - the
                        // frame, not the EOF, is the trigger (spec §10.2).
                        if reconnect.is_none() {
                            if let Some(update) = session.reconnect.take() {
                                session.note(
                                    &format!(
                                        "the daemon is restarting for an update (about {}s) — reconnecting…",
                                        update.est_seconds.max(1)
                                    ),
                                    &mut view,
                                );
                                reconnect = Some(ReconnectLoop::start(&update));
                                session.dirty = true;
                            }
                        }
                        // A dead direct worker link arms the session
                        // re-attach driver (TS `connection_status:
                        // "reconnecting"`): the warning row rides the chat
                        // while the driver retries the attach.
                        if session_reconnect.is_none() {
                            if let Some(lost) = session.transport_lost.take() {
                                // A supervisor loss retained while the direct
                                // link lived: the supervisor client is dead,
                                // so the session-plane retry loop could never
                                // restore it — the full reconnect driver
                                // replaces the client and reattaches.
                                if supervisor_lost && reconnect.is_none() {
                                    session.note_as(
                                        "the daemon connection closed — reconnecting…",
                                        crate::chat::StatusKind::Warning,
                                        &mut view,
                                    );
                                    reconnect = Some(ReconnectLoop::start_lost());
                                    supervisor_lost = false;
                                } else {
                                    session.note_as(
                                        "Daemon connection lost; reconnecting…",
                                        crate::chat::StatusKind::Warning,
                                        &mut view,
                                    );
                                    session_reconnect = Some(SessionReconnect::start(&lost));
                                }
                                session.dirty = true;
                            }
                        }
                    }
                    None => {
                        events_closed = true;
                        if let Some(update) = session.reconnect.take() {
                            // §10: an update restart closed the daemon; the
                            // UI stays mounted and reconnects.
                            session.note(
                                &format!(
                                    "the daemon is restarting for an update (about {}s) — reconnecting…",
                                    update.est_seconds.max(1)
                                ),
                                &mut view,
                            );
                            reconnect = Some(ReconnectLoop::start(&update));
                            session.dirty = true;
                        } else if reconnect.is_some() {
                            // Already reconnecting: the dead channel's
                            // terminal None frames are expected.
                        } else {
                            // An unexpected connection loss (no update in
                            // flight) is a daemon hiccup, not a session
                            // end: the pane keeps its transcript and
                            // retries with the same bounded window and
                            // backoff as the update restart. The user
                            // can leave at any point; the window expires
                            // into the honest exit note.
                            session.note_as(
                                "the daemon connection closed — reconnecting…",
                                crate::chat::StatusKind::Warning,
                                &mut view,
                            );
                            reconnect = Some(ReconnectLoop::start_lost());
                            session.dirty = true;
                        }
                    }
                }
            }
            reader_death = async {
                // One-shot: after the loss is handled (or suppressed), park
                // the arm — the watch stays closed for the rest of the run
                // and a ready arm would hot-spin the select.
                if reader_loss_handled {
                    std::future::pending::<()>().await;
                }
                reader_dead.changed().await
            } => {
                reader_loss_handled = true;
                if reader_death.is_ok() && *reader_dead.borrow_and_update() {
                    // A supervisor socket loss while a live direct link
                    // still serves the session is not a pane-level loss
                    // (session-plane commands ride the link): retain the
                    // loss instead of recovering, and hand it to the full
                    // reconnect driver when the direct link later dies.
                    if session.client.direct_session_id().is_some() {
                        supervisor_lost = true;
                    } else if reconnect.is_none() && session_reconnect.is_none() {
                        session.note_as(
                            "the daemon connection closed — reconnecting…",
                            crate::chat::StatusKind::Warning,
                            &mut view,
                        );
                        reconnect = Some(ReconnectLoop::start_lost());
                        session.dirty = true;
                    }
                }
            }
            maybe_input = ui_rx.recv() => {
                if let Some(input) = maybe_input {
                    pending.push_back(input);
                }
            }
            maybe_note = notes_rx.recv() => {
                if let Some(note) = maybe_note {
                    session.apply_background_note(&note, &mut view);
                }
            }
            maybe_compaction_abort = compaction_abort_rx.recv() => {
                if let Some(outcome) = maybe_compaction_abort {
                    session.apply_compaction_abort_outcome(outcome, &mut view);
                }
            }
            maybe_share = share_rx.recv() => {
                if let Some(outcome) = maybe_share {
                    session.apply_share_outcome(outcome, &mut view);
                }
            }
            maybe_reload = reload_rx.recv() => {
                if let Some(outcome) = maybe_reload {
                    session.apply_reload_outcome(outcome, &mut view).await;
                }
            }
            maybe_traces_upload = traces_upload_rx.recv() => {
                if let Some(note) = maybe_traces_upload {
                    session.apply_traces_upload_note(note, &mut view);
                }
            }
            maybe_catalog = catalog_rx.recv() => {
                if let Some(update) = maybe_catalog {
                    session.apply_model_catalog(update, &mut view);
                }
            }
            maybe_auth_panel = auth_panel_rx.recv() => {
                if let Some(request) = maybe_auth_panel {
                    session.apply_auth_panel_request(request, &mut view).await;
                }
            }
            maybe_heartbeats = heartbeats_rx.recv() => {
                if let Some(update) = maybe_heartbeats {
                    session.apply_heartbeat_update(update, &mut view);
                }
            }
            maybe_bash = bash_rx.recv() => {
                if let Some(update) = maybe_bash {
                    session.apply_bash_activity(update, &mut view);
                }
            }
            maybe_commands = commands_rx.recv() => {
                if let Some(update) = maybe_commands {
                    session.apply_command_catalog(update, &mut view);
                }
            }
            _reconnect_tick = async {
                // Park the tick while an attempt is in flight: the armed
                // `next_attempt` is in the past (the attempt consumed it),
                // so an unparked tick would resolve instantly and
                // busy-spin the loop for the attempt's duration.
                if reconnect_attempt_in_flight {
                    std::future::pending::<()>().await;
                }
                match reconnect.as_ref() {
                    Some(state) => tokio::time::sleep_until(state.next_attempt).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                if reconnect_connect.is_some() {
                    continue;
                }
                let (deadline, lost) = match reconnect.as_ref() {
                    Some(state) => (state.deadline, state.lost),
                    None => continue,
                };
                if tokio::time::Instant::now() > deadline {
                    if lost {
                        session.note(
                            "could not reconnect to the daemon within 10 minutes — run `prime-agent attach` to resume.",
                            &mut view,
                        );
                        session.exit_reason = "daemon_reconnect_failed";
                    } else {
                        session.note(
                            "could not reconnect to the daemon within 10 minutes — the update finished but this window is detached. Run `prime-agent attach` to resume.",
                            &mut view,
                        );
                        session.exit_reason = "update_reconnect_failed";
                    }
                    reconnect = None;
                    session.dirty = true;
                    running = false;
                    continue;
                }
                // The connect leg (bounded connect + hello) runs OFF the
                // loop — the select keeps polling UI input and rendering
                // while it is out; the reattach leg runs inline under its
                // own bound when it lands.
                let socket_path = options.socket_path.clone();
                let (attempt_tx, attempt_rx) = tokio::sync::oneshot::channel();
                reconnect_connect = Some(attempt_rx);
                reconnect_attempt_in_flight = true;
                tokio::spawn(async move {
                    // No outer timeout: dropping the future mid-attempt
                    // would cancel an in-flight handshake without its
                    // reader abort running (a leaked reader and socket on
                    // an accepting-but-silent daemon). The leg self-bounds
                    // — every attempt's connect and hello carry their own
                    // budgets and abort their own reader on failure.
                    let attempt = DaemonClient::connect_with_retry(&socket_path).await;
                    let _ = attempt_tx.send(attempt);
                });
            }
            maybe_attempt = async {
                match reconnect_connect.as_mut() {
                    Some(receiver) => receiver.await,
                    // Nothing in flight: park the arm — the type is
                    // inferred from the in-flight arm, and the tick is the
                    // only spawner (a plain `None` return would hot-spin).
                    None => std::future::pending().await,
                }
            } => {
                reconnect_connect = None;
                reconnect_attempt_in_flight = false;
                let lost = match reconnect.as_ref() {
                    Some(state) => state.lost,
                    None => continue,
                };
                match maybe_attempt {
                    Ok(Ok((client, fresh_events))) => {
                        match tokio::time::timeout(
                            Duration::from_secs(RECONNECT_ATTACH_TIMEOUT_S),
                            session.reattach_after_update(client, &mut view, lost),
                        )
                        .await
                        {
                            Ok(Ok(())) => {
                                events = fresh_events;
                                events_closed = false;
                                reader_dead = session.client.reader_dead();
                                // Re-arm the loss watch for the fresh
                                // connection: the new client's supervisor
                                // reader can die later, and the one-shot
                                // latch must not park that loss.
                                reader_loss_handled = false;
                                session.reconnect = None;
                                reconnect = None;
                                if lost {
                                    session.note_as(
                                        "reconnected to the daemon",
                                        crate::chat::StatusKind::Info,
                                        &mut view,
                                    );
                                }
                                session.dirty = true;
                            }
                            Ok(Err(error)) => {
                                // An unexpected-loss reattach failure is a
                                // hiccup like any other (the worker still
                                // respawning): keep retrying through the
                                // window instead of exiting — the pane never
                                // dies to it (the operator's kicked-out
                                // class). The update path keeps its exit
                                // semantics.
                                if lost {
                                    session.note_as(
                                        &format!("reattach failed: {error:#} — retrying…"),
                                        crate::chat::StatusKind::Warning,
                                        &mut view,
                                    );
                                    session.dirty = true;
                                    if let Some(state) = reconnect.take() {
                                        reconnect = Some(state.next_attempt());
                                    }
                                } else {
                                    session.note(
                                        &format!("reattach after the update failed: {error:#} — run `prime-agent attach` to resume"),
                                        &mut view,
                                    );
                                    session.exit_reason = "update_reattach_failed";
                                    session.dirty = true;
                                    running = false;
                                }
                            }
                            Err(_) => {
                                // The queued attach outlived this attempt's
                                // budget (a long restore): schedule another.
                                session.note(
                                    "the daemon is still restoring — retrying…",
                                    &mut view,
                                );
                                session.dirty = true;
                                if let Some(state) = reconnect.take() {
                                    reconnect = Some(state.next_attempt());
                                }
                            }
                        }
                    }
                    Ok(Err(_)) => {
                        if let Some(state) = reconnect.take() {
                            reconnect = Some(state.next_attempt());
                        }
                    }
                    Err(_) => {
                        // The attempt leg was dropped (a superseded
                        // attempt): the next tick re-arms.
                    }
                }
            }
            _session_reconnect_tick = async {
                match session_reconnect.as_ref() {
                    Some(state) => tokio::time::sleep_until(state.next_attempt).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                let Some(state) = session_reconnect.take() else {
                    continue;
                };
                // The user switched sessions while the link was down: the
                // new attach owns its own connection, so this driver stops.
                if state.active_session_id != session.active_session_id {
                    continue;
                }
                let attempt = tokio::time::timeout(
                    Duration::from_secs(SESSION_RECONNECT_ATTEMPT_TIMEOUT_S),
                    session.attach_session(&state.active_session_id),
                )
                .await;
                match attempt {
                    Ok(Ok(())) => {
                        // The resynced transcript replaces the chat (TS
                        // `session_resynced`), then the reconnected status
                        // lands on the rebuilt chat (TS
                        // `connection_status: "connected"`).
                        session.rebuild_view(
                            &mut view,
                            crate::session_ui::RebuildKind::Resync,
                        );
                        session.note_as(
                            "Daemon reconnected",
                            crate::chat::StatusKind::Info,
                            &mut view,
                        );
                        session.reconnection_failed = None;
                        session_reconnect = None;
                        // TS refreshes the heartbeat catalog on the
                        // `connection_status: "connected"` event.
                        session.spawn_heartbeat_refresh();
                        session.dirty = true;
                    }
                    Ok(Err(error)) => {
                        let mut state = state;
                        state.last_error = format!("{error:#}");
                        if tokio::time::Instant::now() > state.deadline {
                            // TS terminal close: the window expired, the
                            // last error surfaces as the closed event's
                            // error row, and the UI stays mounted without
                            // dispatching anything.
                            let failure =
                                format!("Daemon reconnection failed: {}", state.last_error);
                            session.error_row(&failure, &mut view);
                            session.reconnection_failed = Some(state.last_error.clone());
                            session_reconnect = None;
                            session.dirty = true;
                        } else {
                            session_reconnect = Some(state.next_attempt());
                        }
                    }
                    Err(_) => {
                        let mut state = state;
                        state.last_error =
                            "the session re-attach attempt timed out".to_string();
                        if tokio::time::Instant::now() > state.deadline {
                            let failure =
                                format!("Daemon reconnection failed: {}", state.last_error);
                            session.error_row(&failure, &mut view);
                            session.reconnection_failed = Some(state.last_error.clone());
                            session_reconnect = None;
                            session.dirty = true;
                        } else {
                            session_reconnect = Some(state.next_attempt());
                        }
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                // The input stream went quiet for a tick: parked editor
                // autocomplete requests materialize now (TS resolves
                // suggestions asynchronously after the keystroke batch, so
                // a typed command plus Enter in one burst submits as typed
                // and the dropdown opens only once typing pauses).
                session.materialize_editor_autocomplete(&mut view);
                // The same tick drives the selection auto-scroll (TS's
                // 150 ms hold + 50 ms interval timer): a drag holding the
                // window edge keeps scrolling while no other input
                // arrives, which is the only time this arm runs at that
                // cadence.
                session.selection_auto_scroll_tick(&mut view);
                if last_bash_refresh.elapsed() >= Duration::from_secs(2) {
                    last_bash_refresh = Instant::now();
                    session.spawn_bash_activity_refresh();
                }
            }
            _frame = async {
                match render_deadline {
                    Some(deadline) => {
                        tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await
                    }
                    None => std::future::pending::<()>().await,
                }
            } => {
                // The coalesced frame's deadline arrived: the render gate
                // below paints the accumulated state now.
            }
        }

        // The tray goal label follows the live goal state (TS
        // `syncGoalTray`); the label only changes when the state does.
        session.sync_goal_tray(&mut view);

        // Spinner animation (TS `Loader`'s `setInterval(80ms)` drives the
        // phase, not the render rate): the frame gate below caps renders,
        // so a per-iteration increment would spin the loader too fast —
        // the phase follows the animating clock instead, and only a phase
        // change dirties the frame (TS's interval callback is the only
        // requestRender a quiet turn produces, so a turn without stream
        // events paints at the 80ms loader cadence, not the 16ms frame
        // cap).
        let animating = session.turn_active
            || view.retry.is_some()
            || view.compaction.is_some()
            || view.share_loader.is_some();
        if animating {
            let started = *anim_started.get_or_insert_with(Instant::now);
            let phase = (started.elapsed().as_millis() / SPINNER_INTERVAL_MS) as usize;
            view.pulse_frame = phase;
            if phase != last_pulse_phase {
                session.dirty = true;
            }
            // Arm the next phase boundary: without a deadline the select
            // would only wake on the 50ms tick, adding up to a full tick
            // of spinner latency to every phase change.
            let next_phase =
                started + Duration::from_millis(SPINNER_INTERVAL_MS as u64 * (phase as u64 + 1));
            if render_deadline.is_none_or(|deadline| deadline > next_phase) {
                render_deadline = Some(next_phase);
            }
        } else {
            anim_started = None;
            last_pulse_phase = usize::MAX;
        }

        // The Ctrl+C exit hint expires on a timer (TS
        // `showCtrlCExitHint`'s setTimeout requestRender): once the
        // window passed, the hint row repaints away. The deadline arm
        // lives AFTER the frame gate (a draw resets `render_deadline`,
        // so an arm placed here would be wiped by the same iteration's
        // paint and a fully idle loop would never wake at the expiry).
        if session.ctrl_c_hint_expiry().is_some() {
            hint_painted = true;
        } else if hint_painted {
            session.dirty = true;
            hint_painted = false;
        }

        // The action toasts auto-dismiss on their TTL: once one goes, the
        // overlay repaints away (the same tick-driven repaint the exit
        // hint's expiry uses).
        if view.toasts.prune_expired(Instant::now()) {
            session.dirty = true;
        }

        // The tray override row (the Ctrl+C exit hint, or the streaming
        // follow-up hint over a draft) follows the session's hint state on
        // every frame. Refreshed here — after the select, right before
        // the paint — because a loop-top refresh goes stale across the
        // select's sleep: the expiry-deadline wake would repaint the hint
        // with the pre-sleep value and the corrected tray would never get
        // another paint.
        view.chrome.tray_override = session.tray_override(&view);

        // The frame gate (TS `scheduleRender`: at most one render per
        // MIN_RENDER_INTERVAL_MS): every state change inside the window
        // coalesces into the next frame — a stream burst renders at most
        // one frame per tick instead of one full-transcript layout per
        // event, an idle session re-renders nothing, and a dirty state
        // inside the window waits for the deadline arm above instead of
        // burning a render now.
        if session.dirty {
            if let Some(renderer) = renderer.is_terminal_mut() {
                let interval_elapsed = last_render_at
                    .map(|at| at.elapsed() >= MIN_RENDER_INTERVAL)
                    .unwrap_or(true);
                if interval_elapsed {
                    crate::app::draw(renderer, &mut view)?;
                    session.dirty = false;
                    last_render_at = Some(Instant::now());
                    last_pulse_phase = view.pulse_frame;
                    render_deadline = None;
                } else {
                    render_deadline = Some(last_render_at.unwrap() + MIN_RENDER_INTERVAL);
                }
            } else {
                // Headless capture keeps the per-change frame sequence
                // the verifiers assert on: no wall-clock interval applies.
                renderer.render_headless(&mut session, &mut view);
                session.dirty = false;
                last_pulse_phase = view.pulse_frame;
            }
        } else if render_deadline.is_some_and(|deadline| deadline <= Instant::now()) {
            // A fired deadline with nothing dirty to paint must not
            // re-fire on every iteration (the sleep is in the past, so
            // the arm would return immediately): drop it. A future arm
            // (the spinner's next phase boundary) stays: the select needs
            // that wakeup even when nothing else is dirty.
            render_deadline = None;
        }
        // The armed exit hint's expiry wakeup (see the pre-gate check):
        // armed after the gate so the paint above cannot wipe it — an
        // otherwise idle loop must still wake once to clear the hint row.
        if let Some(until) = session.ctrl_c_hint_expiry() {
            if render_deadline.is_none_or(|deadline| deadline > until) {
                render_deadline = Some(until);
            }
        }
        if session.exit_requested {
            session.exit_reason = "session_request";
            running = false;
        }
    }

    // The run decided to leave: arm the force-quit deadline so every
    // cleanup step below is best-effort (stats fetch, detach, telemetry,
    // the exit flush). A wedged shutdown path cannot hold the process
    // open past it; the healthy path always finishes well inside.
    // A handoff (agents-back, a `/resume` selection) is a view switch,
    // not an exit: the process keeps running, and TS `returnToAgentsView`
    // has no exit deadline — its `teardownSessionUi` drain may take its
    // full second while the app simply waits. Arming here turned a busy
    // box's slow switch into a mid-teardown process kill ("shutdown
    // stalled; forced exit.", the live report), so the deadline covers
    // only the leaves that end this process.
    let handing_off = session.open_agents_view || session.pending_selection.is_some();
    if renderer.is_terminal() && !handing_off {
        exit_guard.arm_for_exit();
    }
    // TS `returnToAgentsView` -> `stashDraftForAgentsView` + the
    // `teardownSessionUi` release: a handoff to the agents view (or a
    // `/resume <selector>` chain — this build's switch surfaces) stashes
    // the live draft for the session being left; every exit releases the
    // run's binding (a held draft stays in the store for the next view).
    if session.open_agents_view || session.pending_selection.is_some() {
        session.stash_draft_for_agents_view(&view);
    }
    session.release_prompt_stash_session();
    // TS `shutdown` fetches the session stats while the connection is
    // alive, then prints the resume hint after teardown; pa-cli prints it
    // once the terminal is restored. Bounded best-effort. The agents-view
    // handoff never prints it (TS `returnToAgentsView` skips the stats
    // fetch entirely — the next surface is another view, not a process
    // exit), so the round-trip is dead work on that path.
    let resume_hint = if session.open_agents_view {
        None
    } else {
        session.exit_resume_hint().await
    };
    // Detach explicitly so the session's attached-client count stays honest;
    // the supervisor also detaches this connection when the socket closes.
    // Bounded hard: a wedged worker socket can never hold the exit path.
    // The agents-view handoff fires the detach in the background instead
    // (attached-client bookkeeping must not delay the switch; the request
    // is on the wire before the handoff returns, and the background task
    // owns this connection until the daemon answers or the cap fires).
    if session.open_agents_view {
        session.detach_for_handoff();
    } else {
        session.detach_for_exit().await;
    }
    // `tui exit` (schema v1): how the run ended. Bounded the same way as
    // the detach — telemetry must never hold the exit path open either.
    // The handoff still emits the event but does not wait for the flush:
    // the agents view keeps the process (and the runtime) alive, so the
    // background flush completes while the user is already in the view
    // (TS hands the pane to the next mode without any teardown await).
    let exit_reason = session.exit_reason();
    let turn_active_at_exit = session.turn_active;
    if let Some(telemetry) = session.telemetry.clone() {
        let exit_event = async move {
            let _ = telemetry
                .client_exit(exit_reason, turn_active_at_exit)
                .await;
        };
        if session.open_agents_view {
            tokio::spawn(exit_event);
        } else {
            let _ =
                tokio::time::timeout(Duration::from_millis(TELEMETRY_EXIT_TIMEOUT_MS), exit_event)
                    .await;
        }
    }
    // Agents-back and `/resume` hand the pane to the agents view; the
    // alternate screen stays in place for it instead of flushing to the
    // main screen (TS `stop({ preserveAltScreen: true })`).
    let preserve_alt_screen = session.open_agents_view;
    let outcome = InteractiveOutcome {
        active_session_id: session.active_session_id.clone(),
        session_id: session.session_id.clone(),
        resume_hint,
        last_assistant_text: session.last_assistant_text.clone(),
        frames: renderer.finish(&mut view, preserve_alt_screen),
        // The headless OSC 52 capture (terminal runs wrote the sequences
        // to stdout as they happened).
        clipboard_emissions: session.take_osc_emissions(),
        return_to_agents_view: preserve_alt_screen,
        agents_view_scope: session.scoped_agents_view.take(),
        selection_request: session.pending_selection,
        copies: std::mem::take(&mut session.copies),
        agents_view_notice: None,
    };
    // The agents-view handoff's background detach owns this connection now
    // (it closes once the daemon answers); every other exit closes it here.
    if !preserve_alt_screen {
        session.client.close();
    }
    // A handoff (agents view, `/resume <selector>`) lets the process keep
    // running: retire the watchdog. Every other completion is a process
    // exit, where the deadline dies with the process — or fires when the
    // exit wedged, which is the point.
    if outcome.return_to_agents_view || outcome.selection_request.is_some() {
        exit_guard.cancel();
    }
    Ok(outcome)
}

/// Seed the static chrome state for a fresh interactive run: splash
/// version/cwd, top-bar name, and the `manage` hint for persisted sessions.
fn apply_startup_chrome(view: &mut AgentView, options: &InteractiveOptions) {
    view.chrome.version.clone_from(&options.version);
    view.chrome.cwd = options.cwd.to_string_lossy().to_string();
    view.chrome.chat_name = crate::chrome::display_name(&view.chrome.cwd);
    view.chrome.show_manage = !options.no_session;
    view.chrome.tray_depth = options.session_rlm_depth;
}

/// The tmux keyboard notice (TS `checkTmuxKeyboardSetup`): warn once per
/// start when tmux runs without `extended-keys`. Runs `tmux show` read-only
/// against the ambient socket; a timeout or error suppresses the notice.
async fn check_tmux_keyboard_setup() -> Option<String> {
    if std::env::var("TMUX").is_err() {
        return None;
    }
    let query = |option: &'static str| async move {
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || {
                std::process::Command::new("tmux")
                    .args(["show", "-gv", option])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .output()
            }),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(Result::ok)
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                None
            }
        })
    };
    let extended_keys = query("extended-keys").await?;
    if extended_keys != "on" && extended_keys != "always" {
        return Some(
            "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.".to_string(),
        );
    }
    None
}

/// Rendering sink: the real terminal or headless frame capture.
enum Renderer {
    Terminal {
        term: Terminal<crate::hyperlinks::LinkBackend>,
        /// The `terminal.fullscreenMouse` setting: mouse tracking
        /// re-enables on resume after a suspended client command.
        mouse: bool,
    },
    Headless {
        width: u16,
        height: u16,
        frames: Vec<String>,
    },
}

/// The renderer handoff of one suspend cycle (TS `handleCtrlZ`):
/// `stop` hands the terminal to the shell (SGR mouse tracking off, alt
/// screen left and flushed into native scrollback, raw mode off);
/// `resume` takes it back after SIGCONT with every mode re-applied.
struct TerminalHandoff<'a> {
    renderer: &'a mut Renderer,
    view: &'a mut AgentView,
}

impl crate::suspend::SuspendTerminal for TerminalHandoff<'_> {
    fn stop(&mut self) -> Result<()> {
        self.renderer.suspend(self.view)
    }

    fn resume(&mut self) -> Result<()> {
        self.renderer.resume()
    }
}

impl Renderer {
    fn setup(
        ui: UiMode,
        ui_tx: mpsc::UnboundedSender<UiInput>,
        exit_guard: ExitGuard,
        mouse: bool,
        surface_mounted: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Renderer> {
        match ui {
            UiMode::Terminal => {
                terminal::enable_raw_mode()?;
                // The terminal state changed: every later setup step is
                // fallible (the alt-screen enter, the mode enables, the
                // terminal construction) and an error from any of them
                // still owns the release. The flag arms here, not at the
                // end of setup.
                surface_mounted.store(true, std::sync::atomic::Ordering::SeqCst);
                // Adopt the alternate screen the previous surface left in
                // place (TS `pendingAltScreenHandoff`); only the first
                // surface of the process enters it, so a view switch never
                // flashes the primary screen.
                crate::altscreen::enter()?;
                // SGR mouse tracking follows the fullscreen surface in and
                // out (TS `enterFullscreen` enables it blind — probing is
                // not viable under tmux and unsupporting terminals ignore
                // the mode-sets).
                if mouse {
                    crate::mouse_tracking::enable(&mut std::io::stdout())?;
                }
                // Bracketed paste and the kitty keyboard protocol come up
                // with the raw-mode bracket (TS `ProcessTerminal.start`):
                // pastes arrive as one chunk instead of per-line Enter
                // submissions, and the kitty probe runs before the reader
                // thread starts polling.
                crate::enhanced_keys::enable(&mut std::io::stdout())?;
                // One reader thread feeds the loop; crossterm events are
                // process-global, so the reader registry joins the previous
                // surface's reader before this one starts polling. The
                // reader also observes Ctrl+C pairs for the exit guard:
                // this thread stays alive when the UI loop is wedged, so
                // the force-quit contract holds regardless of loop state.
                // The paste-aware variant coalesces a marker-less
                // multi-line keystroke burst (tmux 3.2 and older forward
                // pastes without bracketed markers) into one editor paste
                // — TS StdinBuffer's `isRawMultilinePaste`.
                crate::input::spawn_paste_aware_reader(move |input| match input {
                    crate::input::ReaderInput::BurstPaste(text) => {
                        ui_tx.send(UiInput::Paste(text)).is_ok()
                    }
                    // A report the guard reassembled from a sequence
                    // crossterm's reader split at a committed-`ESC` read
                    // boundary: same contract as the terminal's own mouse
                    // events below — consumed unless tracking is active.
                    crate::input::ReaderInput::Mouse(report) => {
                        if !crate::mouse_tracking::active() {
                            true
                        } else {
                            ui_tx.send(UiInput::Mouse(report)).is_ok()
                        }
                    }
                    crate::input::ReaderInput::Event(event) => match event {
                        crossterm::event::Event::Key(key) => {
                            exit_guard.observe_key(&key);
                            ui_tx.send(UiInput::Key(key)).is_ok()
                        }
                        crossterm::event::Event::Paste(text) => {
                            ui_tx.send(UiInput::Paste(text)).is_ok()
                        }
                        // TS forces a full re-render on resize (tui.ts
                        // widthChanged/heightChanged); the loop repaints on
                        // the dirty flag this sets.
                        crossterm::event::Event::Resize(..) => ui_tx.send(UiInput::Resize).is_ok(),
                        // Mouse reports are always consumed (nothing
                        // downstream understands them): wheel turns reach the
                        // loop only while tracking is active (TS consumes
                        // reports even when tracking is disabled).
                        crossterm::event::Event::Mouse(mouse) => {
                            if !crate::mouse_tracking::active() {
                                true
                            } else if let Some(event) = crate::mouse::from_crossterm(&mouse) {
                                ui_tx.send(UiInput::Mouse(event)).is_ok()
                            } else {
                                true
                            }
                        }
                        _ => true,
                    },
                });
                let terminal = Terminal::new(crate::hyperlinks::stdout_backend())?;
                // The adopted buffer still holds the previous view's frame;
                // the first draw repaints the same buffer (a fresh alt
                // screen is already blank). TS paints the new frame
                // straight over the old one, so the clear escape must
                // never reach the pane on its own: queue it with the
                // cursor show and let the first draw's single flush carry
                // clear + frame together — a separate clear-and-flush
                // here shows a blank pane for the whole render gap, a
                // visible flicker on every surface switch (the chat's own
                // first frame is the tail render on the first event).
                crossterm::queue!(
                    std::io::stdout(),
                    crossterm::terminal::Clear(crossterm::terminal::ClearType::All),
                    crossterm::cursor::Show
                )?;
                Ok(Renderer::Terminal {
                    term: terminal,
                    mouse,
                })
            }
            UiMode::Headless(plan) => {
                // The headless harness drives the same dispatch, so the
                // tracking state must read active; the sequence write is
                // gated on a real stdout inside the enable.
                if mouse {
                    crate::mouse_tracking::enable(&mut std::io::stdout())?;
                }
                let steps = plan.steps;
                tokio::spawn(async move {
                    for step in steps {
                        match step {
                            HeadlessStep::Submit(text) => {
                                if ui_tx.send(UiInput::Submit(text)).is_err() {
                                    return;
                                }
                            }
                            HeadlessStep::Type(text) => {
                                for key in typed_keys(&text) {
                                    if ui_tx.send(UiInput::Key(key)).is_err() {
                                        return;
                                    }
                                }
                            }
                            HeadlessStep::Paste(text) => {
                                if ui_tx.send(UiInput::Paste(text)).is_err() {
                                    return;
                                }
                            }
                            HeadlessStep::SettleIdle => {
                                if ui_tx.send(UiInput::SettleIdle).is_err() {
                                    return;
                                }
                            }
                            HeadlessStep::WaitIdle { timeout_ms } => {
                                if ui_tx.send(UiInput::WaitIdle { timeout_ms }).is_err() {
                                    return;
                                }
                            }
                            HeadlessStep::WaitMs(ms) => {
                                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                            }
                            HeadlessStep::ScrollTop => {
                                if ui_tx.send(UiInput::ScrollTop).is_err() {
                                    return;
                                }
                            }
                            HeadlessStep::Mouse(sequence) => {
                                // Mouse reports are always consumed, like
                                // the terminal reader: a wheel turn
                                // reaches the dispatch only while
                                // tracking is active.
                                if crate::mouse_tracking::active()
                                    && crate::mouse::is_mouse_sequence(&sequence)
                                {
                                    if let Some(event) =
                                        crate::mouse::parse_sgr_mouse_event(&sequence)
                                    {
                                        if ui_tx.send(UiInput::Mouse(event)).is_err() {
                                            return;
                                        }
                                    }
                                }
                            }
                            HeadlessStep::Key(key) => {
                                if ui_tx.send(UiInput::Key(key)).is_err() {
                                    return;
                                }
                            }
                        }
                    }
                    let _ = ui_tx.send(UiInput::HeadlessDone);
                });
                Ok(Renderer::Headless {
                    width: plan.width,
                    height: plan.height,
                    frames: Vec::new(),
                })
            }
        }
    }

    /// Hand the terminal back to the process (raw mode off, alternate
    /// screen left and flushed, cursor visible) so an interactive client
    /// command can prompt on it. Headless verification runs keep their
    /// plain pipes. The shared exit tail ends the hand-back — the same
    /// whole-terminal contract every exit guarantees, so a poisoned
    /// start cannot leave the client command prompting on a raw tty
    /// (the TS teardown contract: the shell prompt that follows must
    /// not sit on a hidden cursor or a broken mode).
    fn suspend(&mut self, view: &mut AgentView) -> Result<()> {
        match self {
            Renderer::Terminal { .. } => {
                // The surface releases mouse tracking while a client
                // command prompts on the plain terminal (TS `exitFullscreen`
                // on suspend).
                let _ = crate::mouse_tracking::disable(&mut std::io::stdout());
                // The raw-mode bracket takes the enhanced-key modes with
                // it (TS `stop` on suspend: paste markers off, kitty
                // flags popped); `resume` re-enables both.
                let _ = crate::enhanced_keys::disable(&mut std::io::stdout());
                self.flush_to_main_screen(view)?;
                crate::exit_restore::terminal_release_tail(&mut std::io::stdout());
                Ok(())
            }
            Renderer::Headless { .. } => Ok(()),
        }
    }

    /// Take the terminal back after a suspended client command.
    fn resume(&mut self) -> Result<()> {
        match self {
            Renderer::Terminal { term, mouse } => {
                terminal::enable_raw_mode()?;
                // The suspension released the alternate screen (the client
                // command prompted on the primary one); re-enter it.
                crate::altscreen::enter()?;
                // The raw-mode bracket re-arms the enhanced-key modes (TS
                // `start` on SIGCONT re-runs the paste enable and the kitty
                // query).
                crate::enhanced_keys::enable(&mut std::io::stdout())?;
                // The fullscreen surface re-enables mouse tracking with the
                // terminal (TS `applyFullscreen` on resume).
                if *mouse {
                    crate::mouse_tracking::enable(&mut std::io::stdout())?;
                }
                // A fresh full redraw: the suspended command left arbitrary
                // output behind.
                term.clear()?;
                Ok(())
            }
            Renderer::Headless { .. } => Ok(()),
        }
    }

    /// Leave the alternate screen and paint the accumulated inline layout
    /// onto the main screen (TS `TUI.stop` -> `exitFullscreen`: leave the
    /// alt screen first, then the inline repaint flushes the
    /// fullscreen-era transcript into native scrollback). This is what
    /// keeps the exit frame — and the resume hint the composition root
    /// prints below it — visible after the process exits, instead of the
    /// blank main screen an alt-screen exit alone leaves behind.
    ///
    /// The kill-switch `PRIME_AGENT_TUI_EXIT_FLUSH=0` skips the paint (the
    /// alt screen is still left): the flush is the one new output path that
    /// writes into the user's scrollback, so it can be disabled without a
    /// release if it misbehaves.
    fn flush_to_main_screen(&mut self, view: &mut AgentView) -> Result<()> {
        // Only the terminal renderer owns a real screen to flush;
        // headless verification keeps its plain pipes.
        if !matches!(self, Renderer::Terminal { .. }) {
            return Ok(());
        }
        crate::altscreen::leave()?;
        if !exit_flush_enabled() {
            return Ok(());
        }
        let (width, height) = terminal::size()?;
        let plan = view.take_flush_plan(width as usize, height as usize);
        use std::io::Write;
        let mut out = std::io::stdout();
        let mut buffer = String::new();
        match plan {
            FlushPlan::Append(rows) if rows.is_empty() => {}
            FlushPlan::Append(rows) => {
                write_flush_rows(&mut buffer, &rows);
            }
            FlushPlan::Repaint(rows) => {
                // Erase the visible screen only — scrollback above it
                // stays (TS `fullRender`'s `\x1b[2J\x1b[H`).
                buffer.push_str("\x1b[2J\x1b[H");
                write_flush_rows(&mut buffer, &rows);
            }
        }
        out.write_all(buffer.as_bytes())?;
        out.flush()?;
        Ok(())
    }

    /// Whether this run owns a real terminal (the force-quit guard arms on
    /// terminal runs; headless verification keeps deterministic teardown).
    fn is_terminal(&self) -> bool {
        matches!(self, Renderer::Terminal { .. })
    }

    fn is_terminal_mut(&mut self) -> Option<&mut Terminal<crate::hyperlinks::LinkBackend>> {
        match self {
            Renderer::Terminal { term, .. } => Some(term),
            Renderer::Headless { .. } => None,
        }
    }

    /// Capture one frame as plain text (headless assertions).
    fn render_headless(&mut self, session: &mut SessionUi, view: &mut AgentView) {
        let Renderer::Headless {
            width,
            height,
            frames,
        } = self
        else {
            return;
        };
        let text = crate::app::render_frame_text(view, *width, *height).join("\n");
        if std::env::var("PA_TUI_DEBUG_EVENTS").is_ok() {
            eprintln!(
                "[tui-frame] len={} has_second={} has_again={}",
                text.len(),
                text.contains("second turn"),
                text.contains("again")
            );
        }
        if frames.last().map(String::as_str) != Some(text.as_str()) {
            frames.push(text);
        }
        session.dirty = false;
    }

    /// Teardown. `preserve_alt_screen` mirrors TS `ui.stop({ preserveAltScreen })`:
    /// an exit that hands the pane to the agents view (agents-back, `/resume`)
    /// keeps the alternate screen for the adopting view, hides the cursor, and
    /// skips the main-screen flush — raw mode also stays on, because the
    /// in-process handoff gap would otherwise echo keypresses into the
    /// preserved frame (TS `pendingInputHandoff`). Every other exit follows
    /// TS `TUI.stop`: leave the alt screen, flush the inline frame onto the
    /// main screen, show the cursor, restore cooked mode — the resume hint
    /// the composition root prints next lands right below the flushed frame.
    fn finish(mut self, view: &mut AgentView, preserve_alt_screen: bool) -> Vec<String> {
        // The exit that ends the process stands the kitty probe down
        // FIRST: an answer landing after the pop below would re-arm
        // CSI-u reporting on the parent shell (the "escape codes while
        // typing" leak). A handoff (preserve) keeps the process alive
        // and the next surface's probe — never released here.
        if !preserve_alt_screen && self.is_terminal() {
            crate::enhanced_keys::release_for_exit();
        }
        // In-flight kitty key releases are consumed before the terminal is
        // restored (TS `drainInput` before `stop`): a release that lands
        // after raw mode is off would leak its escape sequence into the
        // parent shell over slow SSH. Runs on every exit — the agents-view
        // handoff drains too (TS `teardownSessionUi`); headless runs hold
        // plain pipes and skip it inside the drain.
        crate::enhanced_keys::drain(&mut std::io::stdout());
        // Tracking releases with the surface (TS `TUI.stop` writes the
        // disable before leaving the alt screen).
        let _ = crate::mouse_tracking::disable(&mut std::io::stdout());
        // The enhanced-key modes release with the raw-mode bracket (TS
        // `stop` writes the paste disable, the kitty pop, and the
        // modifyOtherKeys reset for every exit, handoffs included).
        let _ = crate::enhanced_keys::disable(&mut std::io::stdout());
        match self {
            Renderer::Terminal { .. } => {
                if preserve_alt_screen {
                    let _ = crossterm::execute!(std::io::stdout(), crossterm::cursor::Hide);
                    // Flag this surface's input reader for the background
                    // stop now (TS tears its listener down with the chat):
                    // the next surface joins it at mount, and the already
                    // flagged reader exits at its next poll tick instead
                    // of making the switch wait a full timeout.
                    crate::input::request_reader_stop();
                } else {
                    let _ = self.flush_to_main_screen(view);
                    // The shared exit tail ends the parity teardown: the
                    // synchronized-output release, the SGR reset, the
                    // cursor show, and the cooked-tty verification end in
                    // the same terminal state every exit path guarantees.
                    crate::exit_restore::terminal_release_tail(&mut std::io::stdout());
                }
                Vec::new()
            }
            Renderer::Headless { frames, .. } => frames,
        }
    }
}

/// Encode the flushed rows into `buffer` as one write: each row starts at
/// column 0 (`\r`, required because raw mode maps `\n` to a bare line
/// feed), rows are joined with CRLF, and a trailing CRLF parks the cursor
/// below the frame (TS `TUI.stop`'s closing newline) so whatever prints
/// next — the shell prompt or the resume hint — starts on a fresh line.
fn write_flush_rows(buffer: &mut String, rows: &[crate::Line]) {
    for row in rows {
        buffer.push('\r');
        // An image-placement row is written raw (TS `applyLineResets` /
        // `paint` skip image lines): styling or padding a protocol
        // escape sequence would corrupt the placement.
        let raw: String = row.iter().map(|span| span.content.as_str()).collect();
        if crate::terminal_image::is_image_line(&raw) {
            buffer.push_str(&raw);
        } else {
            buffer.push_str(&crate::ansi::line_to_ansi(row));
        }
        buffer.push_str("\r\n");
    }
}

/// Whether the main-screen exit flush is enabled: on unless
/// `PRIME_AGENT_TUI_EXIT_FLUSH=0` opts out.
fn exit_flush_enabled() -> bool {
    std::env::var_os("PRIME_AGENT_TUI_EXIT_FLUSH").is_none_or(|value| value != "0")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn headless_error_returns_never_touch_the_terminal() {
        // A socket that never listens: the attach fails and the run
        // returns Err. The headless harness never owned the terminal —
        // the wrapper's restore is gated on the terminal ui mode, so a
        // headless error return must not attempt one (the terminal-mode
        // restore is the exit-restore e2e's error-exit scenario, driven
        // on a real terminal).
        let socket =
            std::env::temp_dir().join(format!("tui-exit-restore-dead-{}.sock", std::process::id()));
        let mut opts = options(ModelSelection::default());
        opts.socket_path = socket;
        // The attempts counter is process-global and the unwind-guard test
        // also moves it: this reader holds the shared state lock across
        // its whole read window.
        let _state = crate::exit_restore::TEST_STATE_LOCK.lock();
        let before =
            crate::exit_restore::RESTORE_ATTEMPTS.load(std::sync::atomic::Ordering::SeqCst);
        let result = run_interactive(
            opts,
            UiMode::Headless(HeadlessPlan {
                steps: Vec::new(),
                width: 80,
                height: 24,
            }),
        )
        .await;
        assert!(result.is_err(), "the dead socket must error the run");
        assert_eq!(
            crate::exit_restore::RESTORE_ATTEMPTS.load(std::sync::atomic::Ordering::SeqCst),
            before,
            "the headless error return did not attempt a restore"
        );
    }

    #[test]
    fn flush_rows_write_crlf_and_keep_zone_markers() {
        // A marked row keeps its zero-width zone sequence inline (the
        // flushed row persists into scrollback, where absolute-position
        // marker re-emission cannot reach) and every row lands on its own
        // line with explicit CR (raw mode maps `\n` to a bare line feed).
        let mut marked = vec![crate::Span::raw("hello")];
        crate::osc133::mark_start(&mut marked);
        let styled = vec![crate::Span::styled(
            "world",
            ratatui::style::Style::default().fg(ratatui::style::Color::Indexed(1)),
        )];
        let mut buffer = String::new();
        write_flush_rows(&mut buffer, &[marked, styled]);
        let expected = format!(
            "\r{}hello\r\n\r\x1b[38;5;1mworld\x1b[0m\r\n",
            crate::osc133::ZONE_START
        );
        assert_eq!(buffer, expected);
        // No rows: no output.
        let mut empty = String::new();
        write_flush_rows(&mut empty, &[]);
        assert!(empty.is_empty());
    }

    fn options(selection: ModelSelection) -> InteractiveOptions {
        InteractiveOptions {
            socket_path: PathBuf::from("/tmp/unused.sock"),
            cwd: PathBuf::from("/tmp"),
            session_dir: None,
            script_path: None,
            model_selection: selection,
            model_catalog: Vec::new(),
            model_configured_providers: Default::default(),
            model_recent_models: Vec::new(),
            default_thinking_level: None,
            no_session: false,
            session: SessionSelection::New,
            initial_message: None,
            show_images: true,
            fullscreen_mouse: true,
            theme: "prime".to_string(),
            code_block_indent: "  ".to_string(),
            tree_filter_mode: String::new(),
            branch_summary_skip_prompt: false,
            version: "0.0.0".to_string(),
            onboarding: None,
            telemetry_disabled: None,
            client_auth: None,
            traces: None,
            provider_auth: None,
            update_commands: None,
            telemetry: None,
            keybindings: crate::keybindings::KeybindingsManager::new(),
            session_rlm_depth: None,
            prompt_stash: Default::default(),
            session_has_children: false,
            client_settings: None,
        }
    }

    #[test]
    fn create_config_carries_the_requested_thinking_level() {
        let config = options(ModelSelection {
            thinking: Some(pa_types::ai::ModelThinkingLevel::Max),
            ..Default::default()
        })
        .create_config();
        assert_eq!(config["thinking"], "max");
    }

    #[test]
    fn create_config_omits_thinking_when_no_flag_was_given() {
        let config = options(ModelSelection::default()).create_config();
        assert!(config.get("thinking").is_none());
    }

    #[test]
    fn resume_hint_names_a_flushed_session() {
        let dir = std::env::temp_dir().join("pa-tui-resume-hint-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("session.jsonl");
        std::fs::write(&file, "{}").unwrap();
        let stats = json!({
            "sessionId": "s1",
            "sessionFile": file.display().to_string(),
            "userMessages": 1
        });
        assert_eq!(
            crate::session_ui::resume_hint_from_stats(&stats),
            Some("Resume this session with: prime-agent --resume s1".to_string())
        );
        // An unflushed empty session and a missing session file are both
        // unresumable (TS omits the hint for either).
        assert_eq!(
            crate::session_ui::resume_hint_from_stats(&json!({
                "sessionId": "s1",
                "sessionFile": file.display().to_string(),
                "userMessages": 0
            })),
            None
        );
        assert_eq!(
            crate::session_ui::resume_hint_from_stats(&json!({
                "sessionId": "s1",
                "sessionFile": dir.join("missing.jsonl").display().to_string(),
                "userMessages": 3
            })),
            None
        );
    }
}
