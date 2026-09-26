//! The inline auth panel (TS `LoginDialogComponent` +
//! `PrimeTeamSelectorComponent`, the surfaces `host.showAuthPanel`
//! mounts): the ONE TUI surface the interactive login flows render
//! through. A flow runs in the background and drives the panel through
//! [`AuthPanelHandle`] — progress lines, the browser URL block, a paste
//! prompt, or the Prime team picker — while the TUI run loop folds each
//! request into the mounted panel and answers the prompt/picker requests
//! from the keyboard. No login path ever takes over the plain terminal
//! (the TS auth flows never drop out of the TUI either): no
//! alternate-screen leave, no screen clear, no raw-stdin prompt.
//!
//! The request/reply channel follows the run loop's background-note
//! pattern: the flow's task owns the handle (a plain sender), the loop
//! owns the receiving side, and every prompt carries its own oneshot
//! reply. A flow completion is a request too (the `Settled` variants):
//! the loop unmounts the panel and applies the outcome row.
//!
//! TS carries an abort signal on its login dialog (Esc cancels a running
//! check). The cooperative mirror (#2770): every handle shares one
//! cancel flag — the driving surface marks it when the panel exits and
//! a running flow checks it between its poll steps and before its
//! credential writes (a `JoinHandle::abort` cannot reach a started
//! blocking login body, so the flag is the seam). The paste prompt and
//! the team picker answer their own cancels; the network steps settle
//! within their request timeouts; a settled flow always unmounts the
//! panel.

use ratatui::style::Modifier;
use tokio::sync::{mpsc, oneshot};

use crate::fuzzy::fuzzy_filter;
use crate::hyperlinks::{osc8_open, OSC8_CLOSE};
use crate::keybindings::KeybindingsManager;
use crate::menu_panel::{
    login_field_row, menu_row, no_match_row, scroll_row, scrub_controls, search_field_lines,
    search_field_plain_row, MenuSegment,
};
use crate::provider_auth::ProviderAuthOutcome;
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::traces::TraceLoginOutcome;
use crate::{Line, Span};

/// One Prime team option (TS `PrimeTeam` as the selector renders it).
/// `created_at` is carry-through metadata the flow stores with the
/// selection (the picker never renders it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimeTeamOption {
    pub team_id: String,
    pub name: String,
    pub slug: Option<String>,
    pub role: Option<String>,
    pub created_at: Option<String>,
}

/// The team picker's answer (TS `PrimeTeamSelectorComponent`'s
/// `onSelect`/`onCancel`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrimeTeamPick {
    /// TS `onSelect(team)`.
    Team(PrimeTeamOption),
    /// TS `onSelect(null)`: the personal account.
    PersonalAccount,
    /// TS `onCancel`: the stored selection stays untouched.
    Cancelled,
}

/// How the paste field renders its value (TS `MenuSearchInput`'s masked
/// mode: the token paste panel renders bullets, the login dialog
/// renders the typed key).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteStyle {
    /// The typed value renders as typed (TS `LoginDialogComponent`).
    Visible,
    /// The typed value renders as bullets (TS
    /// `McpTokenPastePanelComponent`: a rendered line never contains the
    /// secret).
    Masked,
}

/// The paste prompt's rendering tone: TS `showManualInput` renders its
/// prompt muted (the browser-step hint under the URL block), while
/// `showPrompt` renders it as a section title in text colour (the API-key
/// prompt "Enter API key:").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PastePromptTone {
    /// TS `addMutedText(prompt)` — `showManualInput`'s arm-prompt.
    Muted,
    /// TS `addSectionTitle(message)` — `showPrompt`'s "Enter API key:".
    Text,
}

/// Which surface mounts the panel: TS `loginDialogOptions()` per surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PanelSurface {
    /// The session's prompt dock (TS the non-onboarding shape):
    /// `topRule: true, hideTitle: false` — the borderMuted rule and the
    /// muted one-space title open the panel.
    Session,
    /// The first-run onboarding block (TS the onboarding shape):
    /// `topRule: false, hideTitle: true` — the splash names the step, so
    /// the panel carries no chrome of its own.
    Onboarding,
}

/// One request a login flow (or its session wrapper) sends to the inline
/// auth panel. Fire-and-forget requests render; the prompt and picker
/// requests await their oneshot replies; the settled requests close the
/// panel and apply the outcome.
pub enum AuthPanelRequest {
    /// TS `dialog.showProgress`: a muted progress line joins the panel.
    /// `chatter` marks the line as the `onProgress` callback's step
    /// chatter (TS `runPrimeInferenceLogin`'s guarded arm): the
    /// onboarding surface drops it — "onboarding narrates itself; step
    /// chatter stays in the chat flows" (TS `if (!this.isOnboarding())`)
    /// — while a direct `showProgress` line (the browser-fallback arm,
    /// the OAuth dialogs' chatter) renders on every surface.
    Progress { message: String, chatter: bool },
    /// TS `dialog.showAuth`: the browser URL block (the flow launches
    /// the browser itself; the panel only renders).
    AuthUrl {
        url: String,
        /// The provider instructions; `None` renders TS's default
        /// "Complete the sign-in in your browser." line.
        instructions: Option<String>,
    },
    /// TS `dialog.showManualInput` / `armManualInput` (the muted prompt)
    /// and `dialog.showPrompt` (the section-title prompt, TS text
    /// colour): the prompt above the panel's paste field. Enter submits
    /// the trimmed value (a blank submit resolves when the prompt allows
    /// it — TS `OAuthPrompt.allowEmpty` — else the field stays mounted:
    /// the token panel shows its notice, the login dialog waits
    /// silently); Esc cancels the flow (`None`).
    PastePrompt {
        prompt: String,
        tone: PastePromptTone,
        style: PasteStyle,
        allow_empty: bool,
        reply: oneshot::Sender<Option<String>>,
    },
    /// TS `PrimeTeamSelectorComponent` mounts over the panel: Esc
    /// cancels the selection (the stored selection stays).
    SelectTeam {
        teams: Vec<PrimeTeamOption>,
        /// TS `currentTeamId`: the stored selection's team id; `None`
        /// marks the personal account current.
        current: Option<String>,
        reply: oneshot::Sender<PrimeTeamPick>,
    },
    /// A provider login settled (`/login`'s rows): the outcome row
    /// applies and the panel unmounts. `provider` is the row's provider
    /// id (the model-picker sign-in route keys its parked retry on it).
    ProviderSettled {
        provider: String,
        outcome: ProviderAuthOutcome,
    },
    /// A `/mcp` view auth command settled: its status line applies.
    McpSettled { note: String },
    /// The `/traces` login settled: the login's outcome applies (the
    /// enable intent continues in the session).
    TracesSettled { outcome: TraceLoginOutcome },
}

/// A login flow's cooperative cancel signal: the flag the blocking body
/// polls before its auth-store writes, and the watch that wakes every
/// pending panel prompt (a prompt's answer can only come from the pane
/// that is exiting, so a pending prompt waits on the watch instead of
/// hanging the exit — the watch keeps the marked value, so a mark that
/// races a wait is never lost).
#[derive(Clone)]
pub struct FlowCancel {
    flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    wake: std::sync::Arc<tokio::sync::watch::Sender<bool>>,
}

impl std::fmt::Debug for FlowCancel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FlowCancel").finish()
    }
}

impl FlowCancel {
    /// The signal starts live (nothing cancelled it yet).
    fn new() -> Self {
        FlowCancel {
            flag: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            wake: std::sync::Arc::new(tokio::sync::watch::channel(false).0),
        }
    }

    /// `true` once the driving pane exited.
    pub fn cancelled(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The bare flag's storage (the #2790 panel consumers load it
    /// directly; every `mark` is visible through it).
    pub(crate) fn flag_arc(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        std::sync::Arc::clone(&self.flag)
    }

    /// The pane exits: mark the flow cancelled and wake every prompt
    /// that is waiting for an answer the exited pane can no longer give.
    pub(crate) fn mark(&self) {
        self.flag.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = self.wake.send(true);
    }

    /// Wait until the flow's cancel signal fires.
    async fn wait(&self) {
        let mut marked = self.wake.subscribe();
        // A mark that landed before the subscribe is already visible in
        // `cancelled`; a mark after it fires `changed`.
        while !self.cancelled() {
            if marked.changed().await.is_err() {
                return;
            }
        }
    }
}

/// The flow-side handle to the inline auth panel: one login run's
/// request channel. The composition root drives its flow against this
/// handle; the TUI run loop owns the receiving side and services every
/// request. Cheap to clone; a clone shares the run's channel and the
/// run's cancel signal.
#[derive(Clone)]
pub struct AuthPanelHandle {
    tx: mpsc::UnboundedSender<AuthPanelRequest>,
    /// The flow's cooperative cancel signal: the driving surface marks
    /// it when the panel or pane exits, and a blocking login body
    /// checks it before its auth-store writes — a `JoinHandle::abort`
    /// cannot reach a started `spawn_blocking` closure (#2770).
    cancel: FlowCancel,
}

impl AuthPanelHandle {
    /// Build the handle over one run's request channel (the session
    /// creates the pair; the loop owns the receiver).
    pub fn new(tx: mpsc::UnboundedSender<AuthPanelRequest>) -> Self {
        AuthPanelHandle {
            tx,
            cancel: FlowCancel::new(),
        }
    }

    /// The flow's cancel state: `true` once the driving surface exited.
    pub fn cancelled(&self) -> bool {
        self.cancel.cancelled()
    }

    /// The flow's cancel signal for the driving side (the pane marks it
    /// on exit; every handle clone shares it).
    pub fn cancel_signal(&self) -> FlowCancel {
        self.cancel.clone()
    }

    /// The bare cancel flag (the #2790 codex login's shape): the
    /// same storage the [`FlowCancel`] arms — loads observe every mark.
    pub fn cancel_flag(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        self.cancel.flag_arc()
    }

    /// Submit one request directly (the helpers below and the session's
    /// settled notes all funnel here).
    pub fn send(&self, request: AuthPanelRequest) {
        let _ = self.tx.send(request);
    }

    /// TS the `onProgress` callback's step chatter (TS `dialog.showProgress`
    /// behind the `if (!this.isOnboarding())` guard): the onboarding
    /// surface drops the line — the flow narrates itself there.
    pub fn progress(&self, message: impl Into<String>) {
        self.send(AuthPanelRequest::Progress {
            message: message.into(),
            chatter: true,
        });
    }

    /// TS a direct `dialog.showProgress` line (the browser-sign-in
    /// fallback arm, the OAuth dialogs' chatter): renders on every
    /// surface, onboarding included.
    pub fn progress_line(&self, message: impl Into<String>) {
        self.send(AuthPanelRequest::Progress {
            message: message.into(),
            chatter: false,
        });
    }

    /// TS `dialog.showAuth`.
    pub fn auth_url(&self, url: &str, instructions: Option<&str>) {
        self.send(AuthPanelRequest::AuthUrl {
            url: url.to_string(),
            instructions: instructions.map(str::to_string),
        });
    }

    /// TS `dialog.showManualInput` / `armManualInput` (the muted
    /// browser-step prompt) and `dialog.showPrompt` (the text-coloured
    /// section-title prompt): prompt above the paste field; the
    /// submitted value resolves the future, a cancel answers `None`.
    pub async fn paste_prompt(
        &self,
        prompt: &str,
        tone: PastePromptTone,
        style: PasteStyle,
    ) -> Option<String> {
        self.paste_prompt_with(prompt, tone, style, false).await
    }

    /// The `allow_empty` variant (TS `OAuthPrompt.allowEmpty`): a blank
    /// submit resolves as an empty answer instead of the notice (the
    /// Copilot domain prompt's "blank for github.com").
    pub async fn paste_prompt_allow_empty(
        &self,
        prompt: &str,
        tone: PastePromptTone,
        style: PasteStyle,
    ) -> Option<String> {
        self.paste_prompt_with(prompt, tone, style, true).await
    }

    /// One paste prompt over the request channel (the two surfaces
    /// above funnel here).
    async fn paste_prompt_with(
        &self,
        prompt: &str,
        tone: PastePromptTone,
        style: PasteStyle,
        allow_empty: bool,
    ) -> Option<String> {
        // An exited pane can never answer the prompt: a cancelled flow
        // returns without sending (the blocking body's next
        // `cancelled` check reports the cancellation).
        if self.cancelled() {
            return None;
        }
        let (reply, answer) = oneshot::channel();
        self.send(AuthPanelRequest::PastePrompt {
            prompt: prompt.to_string(),
            tone,
            style,
            allow_empty,
            reply,
        });
        tokio::select! {
            answered = answer => answered.unwrap_or(None),
            () = self.cancelled_wait() => None,
        }
    }

    /// TS `PrimeTeamSelectorComponent`: the team picker; a cancel
    /// answers [`PrimeTeamPick::Cancelled`] (the stored selection
    /// stays).
    pub async fn select_team(
        &self,
        teams: Vec<PrimeTeamOption>,
        current: Option<&str>,
    ) -> PrimeTeamPick {
        // An exited pane can never answer the picker: a cancelled flow
        // returns the cancelled pick (the stored selection stays).
        if self.cancelled() {
            return PrimeTeamPick::Cancelled;
        }
        let (reply, answer) = oneshot::channel();
        self.send(AuthPanelRequest::SelectTeam {
            teams,
            current: current.map(str::to_string),
            reply,
        });
        tokio::select! {
            picked = answer => picked.unwrap_or(PrimeTeamPick::Cancelled),
            () = self.cancelled_wait() => PrimeTeamPick::Cancelled,
        }
    }

    /// Wait until the flow's cancel signal fires (the pane exited).
    async fn cancelled_wait(&self) {
        self.cancel.wait().await;
    }
}

impl std::fmt::Debug for AuthPanelHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthPanelHandle").finish()
    }
}

/// TS `PREFERRED_VISIBLE_TEAMS`.
const PREFERRED_VISIBLE_TEAMS: usize = 8;

/// The token paste panel's placeholder (TS `MenuSearchInput("Paste
/// token", ..., { masked: true })`).
const TOKEN_PLACEHOLDER: &str = "Paste token";

/// The team picker's panel title (TS `MenuPanel` title).
const TEAM_PANEL_TITLE: &str = "Select a Prime Team:";

/// The team picker's subtitle (TS `MenuPanel` subtitle).
const TEAM_PANEL_SUBTITLE: &str = "Choose which account pays for Prime Inference usage.";

/// The team picker's search placeholder (TS `MenuSearchInput("Search
/// teams")`).
const TEAM_SEARCH_PLACEHOLDER: &str = "Search teams";

/// The login dialog's paste field placeholder (TS
/// `MenuSearchInput("Paste value")` — the session's API-key prompt uses
/// the same field).
pub(crate) const PASTE_PLACEHOLDER: &str = "Paste value";

/// The empty-submit notice (TS `McpTokenPastePanelComponent`'s
/// "The value cannot be empty.").
const EMPTY_VALUE_NOTICE: &str = "The value cannot be empty.";

/// TS `LoginDialogComponent`'s default browser-step line.
const BROWSER_DEFAULT_INSTRUCTIONS: &str = "Complete the sign-in in your browser.";

/// The mounted panel: the flow's progress lines, the browser URL block,
/// and the one active input (a paste prompt or the team picker).
#[derive(Debug)]
pub struct AuthPanel {
    /// TS the dialog's panel title: `Login to {provider}` / `Connect
    /// {service}`.
    title: String,
    /// TS `loginDialogOptions()`'s per-surface chrome: the session's
    /// dock frames the panel with the rule and the title, the onboarding
    /// block mounts it chrome-less (the splash names the step).
    surface: PanelSurface,
    /// TS the `MenuPanel` subtitle; the team picker sets its own.
    subtitle: Option<String>,
    /// TS `showProgress` lines, in arrival order.
    progress: Vec<String>,
    /// Whether the progress block opened the panel (TS `showProgress`'s
    /// empty-content arm renders the "Preparing authentication"
    /// section title only when the panel was still empty).
    progress_open: bool,
    /// TS `showAuth`'s URL block.
    auth_url: Option<String>,
    auth_instructions: Option<String>,
    /// The empty-submit notice row (the token paste panel's arm only).
    notice: Option<String>,
    /// The active input.
    input: PanelInput,
    /// TS the auth-actions row (`getAuthActionsText`): live once
    /// `showAuth` or the paste field mounted it; it rides the panel's
    /// last row.
    actions_live: bool,
    /// TS `copyAuthUrl`'s status: the actions row's success/error line.
    copy_state: Option<CopyState>,
    /// The resolved keybinding labels the actions row renders (TS reads
    /// `getKeybindings()` live; the mounts sync the panel from the
    /// surface's manager).
    keybindings: KeybindingsManager,
    /// The flow's cooperative cancel signal (TS the dialog's
    /// `abortController`): Esc/ctrl+c on a URL screen with no mounted
    /// input cancels the running login — the actions row's cancel hint
    /// is never a dead key.
    flow_cancel: Option<FlowCancel>,
}

/// TS `copyAuthUrl`'s status arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyState {
    Copied,
    Failed,
}

/// The panel's active input.
#[derive(Debug)]
enum PanelInput {
    /// No input mounted: the flow works between requests (its progress
    /// lines stay; Esc has nothing to cancel — the flow settles within
    /// its request timeouts).
    Working,
    /// The paste prompt (TS `showManualInput` / `showPrompt`).
    Paste {
        prompt: String,
        tone: PastePromptTone,
        style: PasteStyle,
        /// Whether a blank submit is a valid answer (TS
        /// `OAuthPrompt.allowEmpty`).
        allow_empty: bool,
        field: SearchInput,
        reply: Option<oneshot::Sender<Option<String>>>,
    },
    /// The team picker (TS `PrimeTeamSelectorComponent`).
    Teams {
        picker: PrimeTeamPicker,
        reply: Option<oneshot::Sender<PrimeTeamPick>>,
    },
}

/// The mounted team picker (TS `PrimeTeamSelectorComponent`): the search
/// field over the personal-first rows.
#[derive(Debug)]
struct PrimeTeamPicker {
    /// The team rows; the personal account rides first as its own row.
    teams: Vec<PrimeTeamOption>,
    /// TS `currentTeamId`: the stored selection's team id; `None` marks
    /// the personal account current.
    current: Option<String>,
    search: SearchInput,
    /// Indices over the full row list (0 = personal, i + 1 = teams[i]).
    filtered: Vec<usize>,
    selected: usize,
}

/// One trailing cell of a team row: a muted detail or the "current"
/// marker (TS `MenuRow`'s meta with `theme.fg("success", ...)`).
enum PickerSegment {
    Muted(String),
    Current,
}

impl AuthPanel {
    /// Mount the panel for one session-surface login run (TS the
    /// non-onboarding `loginDialogOptions`: the rule and the title open
    /// the panel; the dialog mounts the moment the flow starts).
    pub fn new(title: impl Into<String>) -> Self {
        AuthPanel {
            title: scrub_controls(&title.into()),
            surface: PanelSurface::Session,
            subtitle: None,
            progress: Vec::new(),
            progress_open: false,
            auth_url: None,
            auth_instructions: None,
            notice: None,
            input: PanelInput::Working,
            actions_live: false,
            copy_state: None,
            keybindings: KeybindingsManager::new(),
            flow_cancel: None,
        }
    }

    /// Mount the panel inside the first-run onboarding block (TS the
    /// onboarding `loginDialogOptions`: `topRule: false, hideTitle:
    /// true` — the splash renders the step's heading, the panel carries
    /// no chrome of its own). The title stays for the flow's identity;
    /// it never renders on this surface.
    pub fn onboarding(title: impl Into<String>) -> Self {
        let mut panel = AuthPanel::new(title);
        panel.surface = PanelSurface::Onboarding;
        panel
    }

    /// Sync the keybinding labels the actions row renders (TS reads
    /// `getKeybindings()` live at render; the mounts carry the surface's
    /// resolved manager so the row matches the user's bindings).
    pub fn set_keybindings(&mut self, keybindings: KeybindingsManager) {
        self.keybindings = keybindings;
    }

    /// Arm the flow's cooperative cancel signal (TS the dialog's
    /// `abortController`): the mounts pass the driving flow's signal so
    /// the panel's cancel keys end a running login, not just a mounted
    /// input.
    pub fn set_cancel_signal(&mut self, cancel: FlowCancel) {
        self.flow_cancel = Some(cancel);
    }

    /// TS `showProgress`: the first line lands under the section title
    /// (the title renders only when the panel was still empty).
    /// One request-fold entry (the session's channel arm calls it).
    pub fn push_progress(&mut self, message: String) {
        if !self.content_open() {
            self.progress_open = true;
        }
        // The flow's lines can quote provider text: the same control
        // character hygiene every daemon-supplied row carries.
        self.progress.push(scrub_controls(&message));
    }

    /// Whether any content block has landed (TS `contentContainer.children
    /// .length > 0`): the panel renders its leading blank row once
    /// `startContent` ever ran, and the progress section title renders
    /// only before it.
    fn content_open(&self) -> bool {
        self.progress_open || self.auth_url.is_some() || !matches!(self.input, PanelInput::Working)
    }

    /// TS `showAuth`: the URL block replaces the content (the progress
    /// lines and the paste field unmount with it, TS `startContent`
    /// clears) and the auth-actions row goes live. One request-fold
    /// entry (the session's channel arm calls it).
    pub fn show_auth_url(&mut self, url: String, instructions: Option<String>) {
        self.auth_url = Some(url);
        self.auth_instructions = instructions;
        self.progress.clear();
        self.progress_open = false;
        self.input = PanelInput::Working;
        self.notice = None;
        self.actions_live = true;
        self.copy_state = None;
    }

    /// TS `showManualInput` / `armManualInput` (muted tone) and
    /// `showPrompt` (the section-title tone): the prompt above a fresh
    /// paste field (the flow's progress lines stay). One request-fold
    /// entry (the session's channel arm calls it).
    pub fn mount_paste(
        &mut self,
        prompt: String,
        tone: PastePromptTone,
        style: PasteStyle,
        allow_empty: bool,
        reply: oneshot::Sender<Option<String>>,
    ) {
        self.input = PanelInput::Paste {
            prompt: scrub_controls(&prompt),
            tone,
            style,
            allow_empty,
            field: SearchInput::new(),
            reply: Some(reply),
        };
        self.notice = None;
        self.actions_live = true;
        self.copy_state = None;
    }

    /// TS `PrimeTeamSelectorComponent`: the picker mounts as its own
    /// panel (fresh title, subtitle, and rows; the login dialog's
    /// progress lines go with it). One request-fold entry (the
    /// session's channel arm calls it).
    pub fn mount_teams(
        &mut self,
        teams: Vec<PrimeTeamOption>,
        current: Option<String>,
        reply: oneshot::Sender<PrimeTeamPick>,
    ) {
        self.title = TEAM_PANEL_TITLE.to_string();
        self.subtitle = Some(TEAM_PANEL_SUBTITLE.to_string());
        self.progress.clear();
        // The picker is its own panel (TS `PrimeTeamSelectorComponent`):
        // the login dialog's whole content state goes with it — a stale
        // section title, actions row, or copy status must never bleed
        // into the frame the pick leaves behind.
        self.progress_open = false;
        self.actions_live = false;
        self.copy_state = None;
        self.auth_url = None;
        self.auth_instructions = None;
        self.notice = None;
        let mut picker = PrimeTeamPicker {
            teams,
            current,
            search: SearchInput::new(),
            filtered: Vec::new(),
            selected: 0,
        };
        picker.refilter();
        self.input = PanelInput::Teams {
            picker,
            reply: Some(reply),
        };
    }

    /// One key press while the panel owns the frame (TS
    /// `LoginDialogComponent.handleInput` /
    /// `PrimeTeamSelectorComponent.handleInput`). The arms answer the
    /// mounted input through its oneshot; the answered flag hands the
    /// panel back to the flow after the match (the arms never hold the
    /// input's reply past its last use).
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) {
        // Ctrl+C cancels the mounted input like Esc (the surfaces that
        // consume the pair note it handled).
        if key == "ctrl+c" {
            self.cancel_input();
            return;
        }
        // TS `cancel()` on a URL screen (no mounted input): the dialog's
        // abort signal ends the running login — the actions row's cancel
        // hint is never a dead key.
        if matches!(self.input, PanelInput::Working) && kb.matches(key, "tui.select.cancel") {
            self.mark_flow_cancelled();
            return;
        }
        // TS `copyAuthUrl`: the copy binding on the mounted URL (the
        // plain-key arm only while the field is closed — a typed `c` is
        // field input, TS `isTextEntryKeybinding`'s filter).
        if self.auth_url.is_some()
            && kb.matches(key, "app.clipboard.copyLoginUrl")
            && (matches!(self.input, PanelInput::Working) || !is_text_entry_key(key))
        {
            self.copy_auth_url();
            return;
        }
        let mut answered = false;
        match &mut self.input {
            PanelInput::Working => {}
            PanelInput::Paste {
                field,
                style,
                allow_empty,
                reply,
                ..
            } => {
                if kb.matches(key, "tui.select.cancel") {
                    if let Some(reply) = reply.take() {
                        let _ = reply.send(None);
                    }
                    answered = true;
                } else if kb.matches(key, "tui.select.confirm") {
                    let value = field.value().trim().to_string();
                    if value.is_empty() {
                        if *allow_empty {
                            // TS `OAuthPrompt.allowEmpty`: a blank submit
                            // is a valid answer (the Copilot domain
                            // prompt's "blank for github.com").
                            if let Some(reply) = reply.take() {
                                let _ = reply.send(Some(value));
                                answered = true;
                            }
                        } else if *style == PasteStyle::Masked {
                            // TS the token paste panel's empty-submit
                            // notice; the login dialog waits silently (the
                            // arm loop re-reads the field), so only the
                            // masked field shows it.
                            self.notice = Some(EMPTY_VALUE_NOTICE.to_string());
                        }
                    } else if let Some(reply) = reply.take() {
                        let _ = reply.send(Some(value));
                        answered = true;
                    }
                } else {
                    field.handle_key(key, kb);
                }
            }
            PanelInput::Teams { picker, reply } => {
                if kb.matches(key, "tui.select.cancel") {
                    if let Some(reply) = reply.take() {
                        let _ = reply.send(PrimeTeamPick::Cancelled);
                    }
                    answered = true;
                } else if kb.matches(key, "tui.select.up") && !picker.filtered.is_empty() {
                    picker.selected = picker.selected.saturating_sub(1);
                } else if kb.matches(key, "tui.select.down") && !picker.filtered.is_empty() {
                    picker.selected = (picker.selected + 1).min(picker.filtered.len() - 1);
                } else if kb.matches(key, "tui.select.confirm") {
                    if let (Some(pick), Some(reply)) = (picker.pick(), reply.take()) {
                        let _ = reply.send(pick);
                        answered = true;
                    }
                } else {
                    let previous = picker.search.value().to_string();
                    picker.search.handle_key(key, kb);
                    if picker.search.value() != previous {
                        picker.refilter();
                    }
                }
            }
        }
        if answered {
            self.input = PanelInput::Working;
            self.notice = None;
        }
    }

    /// One paste payload while the panel owns the frame (TS the dialog's
    /// field and the selector's search accept pasted text): the payload
    /// lands in the mounted input — the paste field or the picker's
    /// search — never in the hidden editor behind the panel.
    pub fn handle_paste(&mut self, text: &str) {
        match &mut self.input {
            PanelInput::Working => {}
            PanelInput::Paste { field, .. } => field.paste(text),
            PanelInput::Teams { picker, .. } => {
                picker.search.paste(text);
                picker.refilter();
            }
        }
    }

    /// Esc/Ctrl+C on the mounted input: the paste prompt answers `None`
    /// (the flow cancels), the picker answers `Cancelled` (the stored
    /// selection stays, TS `onCancel`); no input means the flow itself
    /// cancels (TS `cancel()`).
    fn cancel_input(&mut self) {
        match &mut self.input {
            PanelInput::Working => self.mark_flow_cancelled(),
            PanelInput::Paste { reply, .. } => {
                if let Some(reply) = reply.take() {
                    let _ = reply.send(None);
                }
                self.input = PanelInput::Working;
            }
            PanelInput::Teams { reply, .. } => {
                if let Some(reply) = reply.take() {
                    let _ = reply.send(PrimeTeamPick::Cancelled);
                }
                self.input = PanelInput::Working;
            }
        }
        self.notice = None;
    }

    /// Mark the driving flow's cancel signal (TS the dialog's abort):
    /// a running login ends between its poll steps; a signal that was
    /// never armed is a flow that owns no cancel path.
    fn mark_flow_cancelled(&mut self) {
        if let Some(cancel) = &self.flow_cancel {
            cancel.mark();
        }
    }

    /// TS `copyAuthUrl`: the mounted URL to the clipboard, the actions
    /// row carrying the outcome ("Copied sign-in link" / "Failed to copy
    /// sign-in link").
    fn copy_auth_url(&mut self) {
        let Some(url) = self.auth_url.clone() else {
            return;
        };
        let mut sink = crate::clipboard::OscSink::Stdout;
        self.copy_state = Some(
            if crate::clipboard::copy_to_clipboard(&url, &mut sink).is_ok() {
                CopyState::Copied
            } else {
                CopyState::Failed
            },
        );
    }

    /// The panel's rendered rows (TS `MenuPanel`'s per-surface chrome over
    /// the `LoginDialogComponent` content: the session's dock opens with
    /// the borderMuted rule and the muted one-space title, the onboarding
    /// block mounts the content chrome-less; the content is the blank
    /// `startContent` row, the progress block, the URL block, the paste
    /// field, and the auth-actions row last — no bottom rule on either
    /// surface).
    pub fn render(&mut self, theme: &Theme, width: usize) -> Vec<Line> {
        let width = width.max(1);
        let mut lines: Vec<Line> = Vec::new();
        // TS `MenuPanel` inline's per-surface chrome: the session dock
        // opens with the borderMuted rule and the muted one-space title
        // (TS `loginDialogOptions`'s non-onboarding shape); the
        // onboarding block mounts the panel chrome-less (`topRule:
        // false, hideTitle: true` — the splash renders the heading).
        if self.surface == PanelSurface::Session {
            lines.push(vec![
                theme.fg_span(ThemeColor::BorderMuted, "\u{2500}".repeat(width))
            ]);
            lines.push(content_row(theme, width, ThemeColor::Muted, &self.title));
            if let Some(subtitle) = &self.subtitle {
                lines.push(content_row(theme, width, ThemeColor::Muted, subtitle));
            }
        }
        // The team picker is TS `PrimeTeamSelectorComponent` — its own
        // panel: the rule, the title, the subtitle, the bordered field,
        // the rows (no leading content blank, no auth-actions row).
        if let PanelInput::Teams { picker, .. } = &mut self.input {
            lines.append(&mut search_field_lines(
                theme,
                width,
                picker.search.value(),
                picker.search.cursor(),
                false,
                TEAM_SEARCH_PLACEHOLDER,
            ));
            let count = picker.filtered.len();
            let visible = PREFERRED_VISIBLE_TEAMS.min(count.max(1));
            let start = if count > visible {
                picker
                    .selected
                    .saturating_sub(visible / 2)
                    .min(count - visible)
            } else {
                0
            };
            let end = (start + visible).min(count);
            for index in start..end {
                let Some(row) = picker.filtered.get(index) else {
                    continue;
                };
                let selected = index == picker.selected;
                let (primary, trailing) = picker.row_parts(*row);
                let segments: Vec<MenuSegment> = trailing
                    .iter()
                    .map(|segment| match segment {
                        PickerSegment::Muted(text) => MenuSegment::muted(text),
                        PickerSegment::Current => {
                            MenuSegment::themed(ThemeColor::Success, "current")
                        }
                    })
                    .collect();
                lines.push(menu_row(theme, width, primary, &segments, selected));
            }
            if start > 0 || end < count {
                lines.push(scroll_row(theme, width, picker.selected + 1, count));
            }
            if count == 0 {
                lines.push(no_match_row(theme, width, "No matching teams"));
            }
            return lines;
        }
        if !self.content_open() {
            // TS renders the empty dialog as zero rows: only the
            // surface's chrome (nothing, on the onboarding block) shows.
            return lines;
        }
        // TS `startContent`'s Spacer(1): the content's leading blank row.
        lines.push(Vec::new());
        // TS `showProgress`'s empty-content arm: the section title rides
        // the first progress line (text colour, TS `addSectionTitle`).
        if self.progress_open {
            lines.push(content_row(
                theme,
                width,
                ThemeColor::Text,
                "Preparing authentication",
            ));
        }
        for message in &self.progress {
            lines.push(content_row(theme, width, ThemeColor::Muted, message));
        }
        if let Some(url) = &self.auth_url {
            // The URL and the instructions are provider-supplied: control
            // characters can never execute terminal control operations
            // when rendered (the same hygiene every daemon-supplied row
            // carries); a URL is additionally single-line, so newlines
            // drop. TS `showAuth` renders the link in the text colour
            // and wraps it in OSC 8 (the URL is the link's own display
            // text) when the terminal is known to implement hyperlinks,
            // else prints it plain.
            let safe = scrub_controls(url).replace('\n', "");
            let linked = if crate::hyperlinks::hyperlinks_enabled() {
                format!("{}{safe}{OSC8_CLOSE}", osc8_open(&safe))
            } else {
                safe
            };
            lines.push(content_row(theme, width, ThemeColor::Text, &linked));
            // TS `addSectionSpacer`: the browser-step text reads apart
            // from the URL.
            lines.push(Vec::new());
            let instructions = self.auth_instructions.clone().map_or_else(
                || BROWSER_DEFAULT_INSTRUCTIONS.to_string(),
                |text| scrub_controls(&text),
            );
            if let Some(code) = verification_code(&instructions) {
                // TS `addInstructions`' code arm: a blank row separates
                // the sign-in link from the code below it.
                lines.push(Vec::new());
                lines.push(content_row(
                    theme,
                    width,
                    ThemeColor::Muted,
                    "Verification code",
                ));
                let bold_code = vec![
                    Span::raw(" ".to_string()),
                    Span::styled(
                        code,
                        theme
                            .fg_style(ThemeColor::Text)
                            .add_modifier(Modifier::BOLD),
                    ),
                ];
                lines.push(crate::width::truncate_line(&bold_code, width, ""));
            } else if self.auth_instructions.is_some() {
                // Provider instructions already describe the browser step
                // (TS renders them in the text colour).
                lines.push(content_row(theme, width, ThemeColor::Text, &instructions));
            } else {
                // TS `addMutedText`'s default browser-step line.
                lines.push(content_row(theme, width, ThemeColor::Muted, &instructions));
            }
        }
        match &mut self.input {
            PanelInput::Working => {}
            PanelInput::Paste {
                prompt,
                tone,
                style,
                field,
                ..
            } => {
                // TS `addSectionSpacer`: the blank before the prompt
                // rides only when content already rendered above (an
                // empty panel's `startContent` blank already opened the
                // body).
                if !self.progress.is_empty() || self.auth_url.is_some() {
                    lines.push(Vec::new());
                }
                let prompt_tone = match tone {
                    PastePromptTone::Muted => ThemeColor::Muted,
                    PastePromptTone::Text => ThemeColor::Text,
                };
                lines.push(content_row(theme, width, prompt_tone, prompt));
                let placeholder = match style {
                    PasteStyle::Visible => PASTE_PLACEHOLDER,
                    PasteStyle::Masked => TOKEN_PLACEHOLDER,
                };
                match style {
                    // The login dialog's field is the plain prompt-bearing
                    // field (TS `MenuSearchInput` inline + plain, no
                    // enclosing rules).
                    PasteStyle::Visible => lines.push(login_field_row(
                        theme,
                        width,
                        field.value(),
                        field.cursor(),
                        true,
                        placeholder,
                    )),
                    // A masked render never contains the secret: only the
                    // bullet projection rides the prompt-less plain field
                    // (TS `McpTokenPastePanelComponent`).
                    PasteStyle::Masked => lines.push(search_field_plain_row(
                        theme,
                        width,
                        &"\u{2022}".repeat(field.value().chars().count()),
                        field.value().chars().count(),
                        true,
                        placeholder,
                    )),
                }
                if let Some(notice) = &self.notice {
                    lines.push(content_row(theme, width, ThemeColor::Warning, notice));
                }
                // TS `addInputField`'s inputSpacer: the blank row between
                // the field and the actions.
                lines.push(Vec::new());
            }
            PanelInput::Teams { .. } => unreachable!("the team picker returned above"),
        }
        if self.actions_live {
            lines.push(auth_actions_row(
                theme,
                width,
                &self.keybindings,
                matches!(self.input, PanelInput::Paste { .. }),
                self.copy_state,
            ));
        }
        lines
    }
}

/// TS `getAuthActionsText`: the key-hint row that rides the panel's last
/// row — the submit hint while the field is visible, the copy status, the
/// copy hint, and the cancel hint, joined by two spaces (the provider
/// selector's API-key prompt renders the same row).
pub(crate) fn auth_actions_row(
    theme: &Theme,
    width: usize,
    keybindings: &KeybindingsManager,
    input_visible: bool,
    copy_state: Option<CopyState>,
) -> Line {
    let mut row: Line = vec![Span::raw(" ".to_string())];
    let mut parts: Vec<Line> = Vec::new();
    if input_visible {
        if let Some(hint) = key_hint_row(theme, keybindings, "tui.select.confirm", "submit") {
            parts.push(hint);
        }
    }
    if let Some(state) = copy_state {
        let tone = match state {
            CopyState::Copied => ThemeColor::Success,
            CopyState::Failed => ThemeColor::Error,
        };
        let text = match state {
            CopyState::Copied => "Copied sign-in link",
            CopyState::Failed => "Failed to copy sign-in link",
        };
        parts.push(vec![theme.fg_span(tone, text.to_string())]);
    }
    // TS `copyHint`: the copy keys (the plain text-entry keys drop out
    // while the field is visible — a typed key is field input), the
    // description turning to "retry" after a failed copy.
    let configured_copy_keys = keybindings.get_keys("app.clipboard.copyLoginUrl");
    let copy_keys = if input_visible {
        configured_copy_keys
            .iter()
            .filter(|key| !is_text_entry_key(key))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        configured_copy_keys
            .iter()
            .take(1)
            .cloned()
            .collect::<Vec<_>>()
    };
    if !copy_keys.is_empty() {
        let action = if copy_state == Some(CopyState::Failed) {
            "retry"
        } else {
            "copy"
        };
        parts.push(vec![
            Span::styled(
                crate::keybindings::format_key_text(&copy_keys.join("/")),
                theme.fg_style(ThemeColor::Dim),
            ),
            Span::styled(format!(" {action}"), theme.fg_style(ThemeColor::Muted)),
        ]);
    }
    if let Some(hint) = key_hint_row(theme, keybindings, "tui.select.cancel", "cancel") {
        parts.push(hint);
    }
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            row.push(Span::raw("  ".to_string()));
        }
        row.extend(part);
    }
    crate::width::truncate_line(&row, width, "")
}

/// One content row at the panel's single-column indent: `" {text}"` in
/// `tone`, truncated to the frame width (TS `MenuPanel` inline prefixes
/// each child row with one space).
fn content_row(theme: &Theme, width: usize, tone: ThemeColor, text: &str) -> Line {
    crate::width::truncate_line(
        &vec![
            Span::raw(" ".to_string()),
            theme.fg_span(tone, text.to_string()),
        ],
        width,
        "",
    )
}

/// TS `keyHint`: the dim key label over the muted ` {action}` — one
/// hint part of the auth-actions row. An unbound action is omitted: the
/// hint never advertises a key the surface does not handle.
fn key_hint_row(
    theme: &Theme,
    keybindings: &KeybindingsManager,
    binding: &str,
    action: &str,
) -> Option<Line> {
    let label = keybindings.key_text(binding);
    if label.is_empty() {
        return None;
    }
    Some(vec![
        Span::styled(label, theme.fg_style(ThemeColor::Dim)),
        Span::styled(format!(" {action}"), theme.fg_style(ThemeColor::Muted)),
    ])
}

/// TS `addInstructions`' code arm (`/^(?:Code|Enter code):\s*(.+)$/i`):
/// the verification code the browser instructions carry, rendered below
/// the muted label.
fn verification_code(instructions: &str) -> Option<String> {
    let trimmed = instructions.trim();
    for prefix in ["Enter code:", "Code:"] {
        let head: String = trimmed.chars().take(prefix.chars().count()).collect();
        if head.eq_ignore_ascii_case(prefix) {
            let code: String = trimmed
                .chars()
                .skip(prefix.chars().count())
                .collect::<String>()
                .trim()
                .to_string();
            if !code.is_empty() {
                return Some(code);
            }
        }
    }
    None
}

/// TS `isTextEntryKeybinding`: a binding without ctrl/alt whose final
/// part is the space key or a single character — the keys a paste field
/// consumes as input, so they copy nothing while the field is visible.
fn is_text_entry_key(key: &str) -> bool {
    let lowered = key.to_lowercase();
    let parts: Vec<&str> = lowered.split('+').collect();
    let last = parts.last().copied().unwrap_or_default();
    !parts
        .iter()
        .any(|part| *part == "ctrl" || *part == "alt" || *part == "super")
        && (last == "space" || last.chars().count() == 1)
}

impl PrimeTeamPicker {
    /// TS `filterOptions`: the fuzzy filter over the full row list; a
    /// fresh query resets the cursor to the first row.
    fn refilter(&mut self) {
        let query = self.search.value().to_string();
        let rows = self.teams.len() + 1;
        self.filtered = if query.is_empty() {
            (0..rows).collect()
        } else {
            fuzzy_filter(&(0..rows).collect::<Vec<_>>(), &query, |row| {
                self.search_text(*row)
            })
        };
        self.selected = 0;
    }

    /// TS `getSearchText`: the personal account or the team's name,
    /// slug, role, and id.
    fn search_text(&self, row: usize) -> String {
        if row == 0 {
            return "personal account".to_string();
        }
        match self.teams.get(row - 1) {
            Some(team) => format!(
                "{} {} {} {}",
                team.name,
                team.slug.clone().unwrap_or_default(),
                team.role.clone().unwrap_or_default(),
                team.team_id
            ),
            None => String::new(),
        }
    }

    /// The row's primary and trailing cells (TS `getPrimary`/
    /// `getSecondary`/`getMeta`): the name with the slug/role detail,
    /// "personal account" for the personal row, and the "current"
    /// marker on the stored selection.
    fn row_parts(&self, row: usize) -> (Line, Vec<PickerSegment>) {
        if row == 0 {
            let mut trailing = vec![PickerSegment::Muted("personal account".to_string())];
            if self.current.is_none() {
                trailing.push(PickerSegment::Current);
            }
            return (vec![Span::raw("Personal")], trailing);
        }
        let Some(team) = self.teams.get(row - 1) else {
            return (Vec::new(), Vec::new());
        };
        // The team fields are provider-supplied: the same control
        // character hygiene every daemon-supplied row carries.
        let name = scrub_controls(&team.name);
        let role = team.role.as_deref().map_or_else(
            || "member".to_string(),
            |role| scrub_controls(role).to_lowercase(),
        );
        let detail = match &team.slug {
            Some(slug) => format!("slug: {}, role: {role}", scrub_controls(slug)),
            None => format!("role: {role}"),
        };
        let mut trailing = vec![PickerSegment::Muted(detail)];
        if self.current.as_deref() == Some(team.team_id.as_str()) {
            trailing.push(PickerSegment::Current);
        }
        (vec![Span::raw(name)], trailing)
    }

    /// TS confirm on the selected row: the personal row answers the
    /// personal account, a team row answers the team; an empty filter
    /// selects nothing.
    fn pick(&self) -> Option<PrimeTeamPick> {
        let row = *self.filtered.get(self.selected)?;
        Some(if row == 0 {
            PrimeTeamPick::PersonalAccount
        } else {
            let team = self.teams.get(row - 1)?;
            PrimeTeamPick::Team(team.clone())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keybindings::KeybindingsManager;

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn theme() -> Theme {
        Theme::builtin("prime", crate::theme::ColorMode::TrueColor)
    }

    fn acme() -> PrimeTeamOption {
        PrimeTeamOption {
            team_id: "team-acme".to_string(),
            name: "Acme Corp".to_string(),
            slug: Some("acme".to_string()),
            role: Some("Owner".to_string()),
            created_at: None,
        }
    }

    fn beta() -> PrimeTeamOption {
        PrimeTeamOption {
            team_id: "team-beta".to_string(),
            name: "Beta Team".to_string(),
            slug: None,
            role: None,
            created_at: None,
        }
    }

    fn frame_text(panel: &mut AuthPanel) -> Vec<String> {
        panel
            .render(&theme(), 90)
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect()
    }

    /// A paste prompt mounted over a panel with its oneshot pair (TS
    /// `armManualInput`'s muted arm prompt).
    fn mount_paste() -> (AuthPanel, oneshot::Receiver<Option<String>>) {
        mount_paste_tone(PastePromptTone::Muted)
    }

    /// A paste prompt with its own tone (TS `showManualInput` renders the
    /// prompt muted, `showPrompt` renders it as the text-coloured section
    /// title).
    fn mount_paste_tone(tone: PastePromptTone) -> (AuthPanel, oneshot::Receiver<Option<String>>) {
        let mut panel = AuthPanel::new("Login to Prime Inference");
        let (reply, answer) = oneshot::channel();
        panel.mount_paste(
            "Paste a Prime API key below:".to_string(),
            tone,
            PasteStyle::Visible,
            false,
            reply,
        );
        (panel, answer)
    }

    /// A team picker mounted with its oneshot pair.
    fn mount_teams(
        teams: Vec<PrimeTeamOption>,
        current: Option<&str>,
    ) -> (AuthPanel, oneshot::Receiver<PrimeTeamPick>) {
        let mut panel = AuthPanel::new("Login to Prime Inference");
        let (reply, answer) = oneshot::channel();
        panel.mount_teams(teams, current.map(str::to_string), reply);
        (panel, answer)
    }

    /// TS `dialog.showProgress`: the first line lands under the section
    /// title.
    #[test]
    fn the_first_progress_line_lands_under_the_section_title() {
        let mut panel = AuthPanel::new("Login to Prime Inference");
        panel.push_progress("Checking existing Prime CLI credentials...".to_string());
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("Login to Prime Inference")));
        assert!(
            rows.iter()
                .any(|row| row.contains("Preparing authentication")),
            "the TS section title rides the first progress: {rows:?}"
        );
        assert!(rows
            .iter()
            .any(|row| row.contains("Checking existing Prime CLI credentials...")));
    }

    /// TS `dialog.showAuth`: the URL renders with its instructions (the
    /// default browser line without them), and the paste field unmounts.
    #[test]
    fn the_auth_url_block_replaces_the_content() {
        let mut panel = AuthPanel::new("Login to Linear");
        panel.mount_paste(
            "Paste the code below:".to_string(),
            PastePromptTone::Muted,
            PasteStyle::Visible,
            false,
            oneshot::channel().0,
        );
        panel.show_auth_url(
            "https://fixture.example/authorize".to_string(),
            Some("Enter the code from the browser.".to_string()),
        );
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("https://fixture.example/authorize")));
        assert!(
            rows.iter()
                .any(|row| row.contains("Enter the code from the browser.")),
            "the instructions render: {rows:?}"
        );
        assert!(
            !rows.iter().any(|row| row.contains("Paste the code below:")),
            "the mounted field unmounts with the content"
        );
        panel.show_auth_url("https://fixture.example/x".to_string(), None);
        let rows = frame_text(&mut panel);
        assert!(
            rows.iter()
                .any(|row| row.contains("Complete the sign-in in your browser.")),
            "the TS default browser line renders: {rows:?}"
        );
    }

    /// The paste prompt renders the TS prompt row, the plain `> ` field
    /// with the "Paste value" placeholder, and the auth-actions row;
    /// Enter submits the trimmed value through the oneshot. TS
    /// `addInputField`: a blank row rides between the field and the
    /// actions.
    #[test]
    fn the_paste_prompt_submits_the_typed_value() {
        let (mut panel, mut answer) = mount_paste();
        // The mounted field shows its placeholder while empty, the prompt
        // row above it, and the actions row below.
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("Paste a Prime API key below:")));
        let field = rows
            .iter()
            .position(|row| row.contains("Paste value"))
            .expect("the plain field row");
        assert!(
            rows[field].starts_with(" > "),
            "the field keeps its `> ` prompt: {rows:?}"
        );
        let rules = rows
            .iter()
            .filter(|row| !row.is_empty() && row.chars().all(|c| c == '\u{2500}'))
            .count();
        assert_eq!(
            rules, 1,
            "the session panel's top rule alone rides; the field adds none: {rows:?}"
        );
        assert!(
            rows[0].chars().all(|c| c == '\u{2500}'),
            "the rule opens the panel"
        );
        // The actions row: submit while the field is visible, the copy key
        // filtered to its non-text-entry arm, the cancel keys (TS
        // `getAuthActionsText`).
        assert!(rows
            .iter()
            .any(|row| row.contains("Enter submit  Alt+C copy  Esc/Ctrl+C cancel")));
        for character in "  sk-live  ".chars() {
            panel.handle_key(character.to_string().as_str(), &kb());
        }
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(Some("sk-live".to_string())));
    }

    /// Esc on the paste prompt cancels the flow (`None`), TS the dialog
    /// cancel.
    #[test]
    fn escape_on_the_paste_prompt_cancels_the_flow() {
        let (mut panel, mut answer) = mount_paste();
        panel.handle_key("escape", &kb());
        assert_eq!(answer.try_recv(), Ok(None));
    }

    /// TS the token paste panel: an empty submit keeps the field mounted
    /// and shows the notice; the submit that follows still works. The
    /// login dialog's visible field waits silently instead (TS
    /// `armManualInput`'s `while (!value)` loop never shows a notice).
    #[test]
    fn an_empty_paste_submit_shows_the_notice_only_on_the_token_panel() {
        let mut panel = AuthPanel::new("Connect GitHub");
        let (reply, mut answer) = oneshot::channel();
        panel.mount_paste(
            "Paste the token for github:".to_string(),
            PastePromptTone::Text,
            PasteStyle::Masked,
            false,
            reply,
        );
        panel.handle_key("enter", &kb());
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("The value cannot be empty.")));
        assert!(answer.try_recv().is_err(), "nothing answered");
        panel.handle_key("k", &kb());
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(Some("k".to_string())));

        // The login dialog's visible field: an empty submit mounts no
        // notice (the arm loop re-reads the field, TS keeps waiting).
        let (mut panel, mut answer) = mount_paste();
        panel.handle_key("enter", &kb());
        let rows = frame_text(&mut panel);
        assert!(
            !rows
                .iter()
                .any(|row| row.contains("The value cannot be empty.")),
            "the login dialog waits silently: {rows:?}"
        );
        assert!(answer.try_recv().is_err(), "nothing answered");
    }

    /// TS `OAuthPrompt.allowEmpty`: a prompt that allows the blank entry
    /// submits it as a valid answer (the Copilot domain prompt's
    /// "blank for github.com"), without the notice.
    #[test]
    fn an_allow_empty_paste_prompt_submits_the_blank_answer() {
        let mut panel = AuthPanel::new("Login to GitHub Copilot");
        let (reply, mut answer) = oneshot::channel();
        panel.mount_paste(
            "GitHub Enterprise URL/domain (blank for github.com)".to_string(),
            PastePromptTone::Text,
            PasteStyle::Visible,
            true,
            reply,
        );
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(Some(String::new())));
        let rows = frame_text(&mut panel);
        assert!(
            !rows
                .iter()
                .any(|row| row.contains("The value cannot be empty.")),
            "the blank entry is a valid answer, not a notice"
        );
    }

    /// TS `McpTokenPastePanelComponent`: a masked field renders bullets,
    /// never the secret.
    #[test]
    fn the_masked_field_renders_bullets_never_the_secret() {
        let mut panel = AuthPanel::new("Connect GitHub");
        panel.mount_paste(
            "Paste the token for github:".to_string(),
            PastePromptTone::Text,
            PasteStyle::Masked,
            false,
            oneshot::channel().0,
        );
        for character in "ghp_secretvalue".chars() {
            panel.handle_key(character.to_string().as_str(), &kb());
        }
        let rows = frame_text(&mut panel);
        let joined = rows.join("\n");
        assert!(
            !joined.contains("ghp_secretvalue"),
            "the secret never renders: {joined:?}"
        );
        assert!(
            joined.contains("\u{2022}\u{2022}\u{2022}"),
            "bullets render"
        );
    }

    /// The team picker renders the TS `PrimeTeamSelectorComponent`
    /// panel: the title and subtitle, the search field, Personal first
    /// with its meta and the current marker, and the slug/role detail.
    #[test]
    fn the_team_picker_renders_the_ts_rows() {
        let (mut panel, _answer) = mount_teams(vec![acme(), beta()], Some("team-beta"));
        let rows = frame_text(&mut panel);
        assert!(rows.iter().any(|row| row.contains("Select a Prime Team:")));
        assert!(rows
            .iter()
            .any(|row| { row.contains("Choose which account pays for Prime Inference usage.") }));
        assert!(rows.iter().any(|row| row.contains("Search teams")));
        assert!(rows.iter().any(|row| row.contains("Personal")));
        assert!(rows.iter().any(|row| row.contains("personal account")));
        assert!(rows.iter().any(|row| row.contains("Acme Corp")));
        assert!(rows
            .iter()
            .any(|row| row.contains("slug: acme, role: owner")));
        assert!(rows.iter().any(|row| row.contains("role: member")));
        // The stored selection (Beta) is the current row; the personal
        // row carries no current marker.
        let beta_row = rows
            .iter()
            .find(|row| row.contains("Beta Team"))
            .expect("the beta row");
        assert!(beta_row.contains("current"), "the beta row: {beta_row:?}");
        assert!(
            !rows
                .iter()
                .any(|row| row.contains("personal account · current")),
            "personal is not current while a team is stored"
        );
    }

    /// With no stored selection the personal account is the current row
    /// (TS `getMeta`).
    #[test]
    fn the_personal_row_is_current_without_a_stored_selection() {
        let (mut panel, _answer) = mount_teams(vec![acme()], None);
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("personal account · current")));
    }

    /// Down/Enter on the picker answers the selected team (TS
    /// `onSelect`); the personal row answers the personal account.
    #[test]
    fn the_picker_navigates_and_picks() {
        let (mut panel, mut answer) = mount_teams(vec![acme(), beta()], None);
        panel.handle_key("down", &kb());
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Team(acme())));
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::PersonalAccount));
    }

    /// TS `onCancel`: Esc answers the cancelled pick (the stored
    /// selection stays; the flow resolves the default status).
    #[test]
    fn escape_on_the_picker_answers_the_cancelled_pick() {
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_key("escape", &kb());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Cancelled));
    }

    /// TS `filterOptions`: the search filters over the personal row's and
    /// the teams' search text (name, slug, role, id); Enter on the
    /// surviving row picks it.
    #[test]
    fn the_picker_search_filters_and_picks_the_surviving_row() {
        let (mut panel, mut answer) = mount_teams(vec![acme(), beta()], None);
        for character in "acme".chars() {
            panel.handle_key(character.to_string().as_str(), &kb());
        }
        let rows = frame_text(&mut panel);
        assert!(rows.iter().any(|row| row.contains("Acme Corp")));
        assert!(
            !rows.iter().any(|row| row.contains("Beta Team")),
            "the non-match is filtered out: {rows:?}"
        );
        assert!(
            !rows.iter().any(|row| row.contains("Personal")),
            "the personal row is filtered out too: {rows:?}"
        );
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Team(acme())));
        // The personal row's search text matches "personal account".
        let (mut panel, _answer) = mount_teams(vec![acme()], None);
        for character in "personal".chars() {
            panel.handle_key(character.to_string().as_str(), &kb());
        }
        let rows = frame_text(&mut panel);
        assert!(rows.iter().any(|row| row.contains("Personal")));
        assert!(
            !rows.iter().any(|row| row.contains("Acme Corp")),
            "the team row is filtered out: {rows:?}"
        );
    }

    /// A filter that matches nothing renders the TS empty row, and Enter
    /// selects nothing (the reply stays mounted, TS `if (selected)`).
    #[test]
    fn an_empty_filter_renders_the_ts_empty_row_and_selects_nothing() {
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        for character in "zzz".chars() {
            panel.handle_key(character.to_string().as_str(), &kb());
        }
        let rows = frame_text(&mut panel);
        assert!(rows.iter().any(|row| row.contains("No matching teams")));
        panel.handle_key("enter", &kb());
        assert!(
            answer.try_recv().is_err(),
            "an empty filter selects nothing"
        );
    }

    /// The picker's navigation clamps at both ends (TS
    /// `Math.max(0, ...)` / `Math.min(...)`; no wrap): up from the first
    /// row stays personal, down past the last row stays on it.
    #[test]
    fn the_picker_navigation_clamps_instead_of_wrapping() {
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_key("up", &kb());
        panel.handle_key("enter", &kb());
        assert_eq!(
            answer.try_recv(),
            Ok(PrimeTeamPick::PersonalAccount),
            "up clamps at the personal row (index 0)"
        );
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_key("down", &kb());
        panel.handle_key("down", &kb());
        panel.handle_key("enter", &kb());
        assert_eq!(
            answer.try_recv(),
            Ok(PrimeTeamPick::Team(acme())),
            "down clamps at the last row"
        );
    }

    /// A request with no mounted panel is not an error path for the
    /// handle: the dropped reply cancels the flow (the old terminal
    /// input's EOF contract).
    #[tokio::test]
    async fn a_dropped_prompt_reply_cancels_the_flow() {
        let (tx, rx) = mpsc::unbounded_channel();
        // The receiving side is gone (the run loop's channel died with
        // the session): the dropped request's reply cancels the flow —
        // the paste prompt answers `None`, the picker `Cancelled`.
        drop(rx);
        let handle = AuthPanelHandle::new(tx);
        assert_eq!(
            handle
                .paste_prompt("Paste a key:", PastePromptTone::Muted, PasteStyle::Visible)
                .await,
            None
        );
        assert_eq!(
            handle.select_team(vec![acme()], None).await,
            PrimeTeamPick::Cancelled
        );
    }

    /// A paste payload lands in the mounted field (never the hidden
    /// editor): the pasted value submits through the oneshot.
    #[test]
    fn a_paste_payload_lands_in_the_mounted_field() {
        let (mut panel, mut answer) = mount_paste();
        panel.handle_paste("  sk-pasted-key  ");
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(Some("sk-pasted-key".to_string())));
        // The picker's search accepts pasted text too (TS `MenuSearchInput`).
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_paste("acme");
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Team(acme())));
    }

    /// Provider-supplied text can never execute terminal control
    /// operations: the panel scrubs control characters out of the title,
    /// the URL block, the instructions, the paste prompt, and the team
    /// rows (the URL is additionally single-line for the OSC 8 wrap).
    #[test]
    fn provider_text_is_scrubbed_never_a_terminal_sequence() {
        let mut panel = AuthPanel::new("Login to \u{1b}]8;;https://evil.example\u{7}Evil");
        panel.push_progress("Loading\u{1b}[2J teams...".to_string());
        panel.show_auth_url(
            "https://a.example/\u{1b}]8;;https://evil.example\u{7}link\u{1b}\\\u{1b}]8;;\u{1b}\\"
                .to_string(),
            Some("Open\r\nhttps://evil".to_string()),
        );
        let rows = frame_text(&mut panel);
        let joined = rows.join("\n");
        assert!(
            !joined.contains("\u{1b}]8;;https://evil.example"),
            "the escape never renders: {joined:?}"
        );
        assert!(
            !joined.contains("\u{1b}[2J"),
            "the clear never renders: {joined:?}"
        );
        assert!(!joined.contains("\u{1b}]8;;"));

        let (mut panel, mut _answer) = mount_teams(
            vec![PrimeTeamOption {
                team_id: "t".to_string(),
                name: "A\u{1b}[2J Corp".to_string(),
                slug: Some("s\u{7}".to_string()),
                role: Some("Owner\u{1b}".to_string()),
                created_at: None,
            }],
            None,
        );
        let rows = frame_text(&mut panel);
        let joined = rows.join("\n");
        assert!(!joined.contains('\u{1b}'), "no escapes render: {joined:?}");
        assert!(joined.contains('A'), "the scrubbed name still renders");
    }

    /// The OSC 8 link carries the URL as its own display text (an empty
    /// link region would paint an empty row on hyperlink terminals).
    #[test]
    fn the_auth_url_link_carries_the_url_as_display_text() {
        let mut panel = AuthPanel::new("Login to Linear");
        panel.show_auth_url("https://fixture.example/authorize".to_string(), None);
        let rows = frame_text(&mut panel);
        let linked = rows
            .iter()
            .find(|row| row.contains("https://fixture.example/authorize"))
            .expect("the URL row");
        // The plain URL renders (hyperlinks off in the test env renders it
        // unlinked; the hyperlink path wraps the same text inside the
        // sequence pair).
        assert!(linked.contains("https://fixture.example/authorize"));
    }

    /// The session surface's panel chrome is TS `MenuPanel` inline: the
    /// borderMuted rule, the muted one-space title — and NO bottom rule,
    /// NO leading blank (the content's own `startContent` blank opens
    /// the body).
    #[test]
    fn the_session_chrome_is_the_ts_inline_panel() {
        let mut panel = AuthPanel::new("Login to Prime Inference");
        let rows = frame_text(&mut panel);
        assert_eq!(
            rows.len(),
            2,
            "the empty dialog renders its chrome alone: {rows:?}"
        );
        assert!(
            rows[0].chars().all(|c| c == '\u{2500}'),
            "the rule opens the panel: {rows:?}"
        );
        assert_eq!(
            rows[1], " Login to Prime Inference",
            "the muted 1-space title"
        );
        panel.push_progress("Opening the browser challenge...".to_string());
        let rows = frame_text(&mut panel);
        assert_eq!(rows[2], "", "the startContent blank opens the body");
        assert!(
            !rows.iter().any(|row| row == " Login to Prime Inference  "),
            "no 2-space raw title rides the panel"
        );
        // No bottom rule: the last row is the content's.
        assert!(
            !rows
                .last()
                .is_some_and(|row| row.chars().all(|c| c == '\u{2500}')),
            "the inline panel closes on its content: {rows:?}"
        );
    }

    /// The onboarding surface mounts the dialog chrome-less (TS
    /// `loginDialogOptions`: `topRule: false, hideTitle: true` — the
    /// splash's heading names the step): an empty panel renders zero
    /// rows.
    #[test]
    fn the_onboarding_panel_is_chrome_less() {
        let mut panel = AuthPanel::onboarding("Login to Prime Inference");
        let rows = frame_text(&mut panel);
        assert!(
            rows.is_empty(),
            "the empty onboarding dialog renders nothing: {rows:?}"
        );
        panel.show_auth_url("https://fixture.example/authorize".to_string(), None);
        let rows = frame_text(&mut panel);
        assert!(
            !rows
                .iter()
                .any(|row| !row.is_empty() && row.chars().all(|c| c == '\u{2500}')),
            "no rule rides the onboarding dialog: {rows:?}"
        );
        assert!(
            !rows
                .iter()
                .any(|row| row.contains("Login to Prime Inference")),
            "no title rides the onboarding dialog: {rows:?}"
        );
        // The body: the startContent blank, the text-coloured URL, the
        // section spacer, the muted default browser line, the actions.
        assert_eq!(rows[0], "");
        assert_eq!(rows[1], " https://fixture.example/authorize");
        assert_eq!(rows[2], "");
        assert_eq!(rows[3], " Complete the sign-in in your browser.");
        assert_eq!(
            rows[4], " C copy  Esc/Ctrl+C cancel",
            "the TS auth-actions row: {rows:?}"
        );
    }

    /// TS `showAuth`'s frame with provider instructions: the URL renders
    /// in the text colour (never the accent), the instructions in the
    /// text colour, and a code-carrying line becomes the verification
    /// code block (the muted label, the bold code, the separating
    /// blank).
    #[test]
    fn the_url_block_renders_the_ts_instruction_frames() {
        let mut panel = AuthPanel::onboarding("Login to Linear");
        panel.show_auth_url(
            "https://fixture.example/authorize".to_string(),
            Some("Complete the OAuth flow.".to_string()),
        );
        let rows = frame_text(&mut panel);
        assert_eq!(rows[1], " https://fixture.example/authorize");
        assert_eq!(rows[3], " Complete the OAuth flow.");
        panel.show_auth_url(
            "https://fixture.example/authorize".to_string(),
            Some("Enter code: 4242-9911".to_string()),
        );
        let rows = frame_text(&mut panel);
        let code = rows
            .iter()
            .position(|row| row.contains("4242-9911"))
            .expect("the code row");
        assert_eq!(rows[code - 1], " Verification code");
        assert_eq!(rows[code - 2], "", "the blank separates link and code");
    }

    /// TS `cancel()` on a URL screen: the actions row advertises the
    /// cancel keys and Esc ends the running login through the flow's
    /// cooperative cancel signal (never a dead hint).
    #[test]
    fn escape_on_a_url_screen_marks_the_flow_cancelled() {
        let mut panel = AuthPanel::onboarding("Login to Prime Inference");
        let handle = AuthPanelHandle::new(mpsc::unbounded_channel().0);
        let cancel = handle.cancel_signal();
        panel.set_cancel_signal(cancel.clone());
        panel.show_auth_url("https://fixture.example/authorize".to_string(), None);
        assert!(
            !cancel.cancelled(),
            "the flow starts live: the URL screen alone cancels nothing"
        );
        panel.handle_key("escape", &kb());
        assert!(
            cancel.cancelled(),
            "Esc on the URL screen ends the running login (TS the dialog's abort)"
        );
    }

    /// TS `copyAuthUrl`: the copy binding on the mounted URL carries the
    /// clipboard outcome into the actions row; a typed plain key stays
    /// field input while the field is visible (the alt arm copies).
    #[test]
    fn the_copy_binding_copies_the_mounted_url_into_the_actions_row() {
        let mut panel = AuthPanel::onboarding("Login to Prime Inference");
        panel.show_auth_url("https://fixture.example/authorize".to_string(), None);
        panel.handle_key("c", &kb());
        let rows = frame_text(&mut panel);
        assert!(
            rows.iter().any(|row| row.contains("Copied sign-in link")
                || row.contains("Failed to copy sign-in link")),
            "the copy outcome rides the actions row: {rows:?}"
        );
        // Without a mounted URL the copy binding does nothing: the plain
        // `c` lands in the paste field as input (the URL guard holds).
        let (mut panel, mut _answer) = mount_paste();
        panel.handle_key("c", &kb());
        let rows = frame_text(&mut panel);
        assert!(
            !rows.iter().any(|row| row.contains("Copied sign-in link")),
            "no URL means no copy: {rows:?}"
        );
        let field = rows
            .iter()
            .find(|row| row.contains("Paste value") || row.contains('c'))
            .expect("the field row");
        assert!(
            field.contains('c'),
            "the plain key typed into the field: {rows:?}"
        );
    }
}
