//! The inline auth panel (TS `LoginDialogComponent`): the ONE TUI surface the interactive
//! login flows render through, driven by [`AuthPanelHandle`] while the run loop folds each
//! request into the mounted panel. No login path ever takes over the plain terminal: no
//! alternate-screen leave, no screen clear, no raw-stdin prompt.

use ratatui::style::Modifier;
use tokio::sync::{mpsc, oneshot};

use crate::fuzzy::fuzzy_filter;
use crate::hyperlinks::{osc8_open, OSC8_CLOSE};
use crate::keybindings::KeybindingsManager;
use crate::menu_panel::{
    hint_row, key_hint, login_field_row, menu_row, no_match_row, scroll_row, scrub_controls,
    search_field_lines, search_field_plain_row, MenuSegment,
};
use crate::provider_auth::ProviderAuthOutcome;
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::traces::TraceLoginOutcome;
use crate::{Line, Span};

mod render;

pub(crate) use render::auth_actions_row;
#[cfg(test)]
use render::verification_code;

mod picker;

use picker::{PickerSegment, PrimeTeamPicker};

/// One Prime team option (TS `PrimeTeam` as the selector renders it). `created_at` is
/// carry-through metadata the flow stores; the picker never renders it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimeTeamOption {
    pub team_id: String,
    pub name: String,
    pub slug: Option<String>,
    pub role: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrimeTeamPick {
    Team(PrimeTeamOption),
    /// The personal account.
    PersonalAccount,
    /// The stored selection stays untouched.
    Cancelled,
}

/// How the paste field renders its value: bullets for the token paste panel, the typed key for the
/// login dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteStyle {
    Visible,
    /// The typed value renders as bullets — a rendered line never contains the secret.
    Masked,
}

/// The paste prompt's rendering tone: the browser-step hint renders muted; the API-key prompt
/// renders as a section title in text colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PastePromptTone {
    Muted,
    Text,
}

/// Which surface mounts the panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PanelSurface {
    /// The session's prompt dock: the rule and the muted title open the panel.
    Session,
    /// The first-run onboarding block: the splash names the step, so the panel carries no chrome
    /// of its own.
    Onboarding,
}

/// One request a login flow sends to the inline auth panel: fire-and-forget requests render;
/// prompts and pickers await their oneshot replies; settled requests close the panel.
pub enum AuthPanelRequest {
    /// A muted progress line joins the panel. `chatter` marks the flow's step chatter (TS
    /// `onProgress`), which the onboarding surface drops.
    Progress { message: String, chatter: bool },
    /// The polling device flow's waiting line — the accent row above the actions row; renders on
    /// every surface, unlike the onboarding-dropped `chatter` arm.
    Waiting { message: String },
    /// The browser URL block (the flow launches the browser itself; the panel only renders).
    AuthUrl {
        url: String,
        /// The provider instructions; `None` renders the default "Complete the sign-in in your
        /// browser." line.
        instructions: Option<String>,
    },
    /// The prompt above the panel's paste field. Enter submits the trimmed value (a blank submit
    /// resolves only when `allow_empty`, else the field stays mounted); Esc cancels the flow.
    PastePrompt {
        prompt: String,
        tone: PastePromptTone,
        style: PasteStyle,
        allow_empty: bool,
        reply: oneshot::Sender<Option<String>>,
    },
    /// The team picker mounts over the panel: Esc cancels the selection (the stored selection
    /// stays).
    SelectTeam {
        teams: Vec<PrimeTeamOption>,
        /// The stored selection's team id; `None` marks the personal account current.
        current: Option<String>,
        reply: oneshot::Sender<PrimeTeamPick>,
    },
    /// A provider login settled: the outcome row applies and the panel unmounts. `provider` is the
    /// row's provider id (the model-picker sign-in route keys its parked retry on it).
    ProviderSettled {
        provider: String,
        outcome: ProviderAuthOutcome,
    },
    /// A `/mcp` view auth command settled: its status line applies.
    McpSettled { note: String },
    /// The `/traces` login settled: the login's outcome applies. `gen` is matched against the
    /// run loop's counter so a superseded run's late settle cannot clear a newer login.
    TracesSettled {
        outcome: TraceLoginOutcome,
        gen: u64,
    },
}

/// A login flow's cooperative cancel signal: the flag the blocking body polls before its
/// auth-store writes, and the watch that wakes every pending panel prompt.
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
    fn new() -> Self {
        FlowCancel {
            flag: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            wake: std::sync::Arc::new(tokio::sync::watch::channel(false).0),
        }
    }

    #[must_use]
    pub fn cancelled(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The bare flag's storage (the #2790 panel consumers load it directly).
    pub(crate) fn flag_arc(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        std::sync::Arc::clone(&self.flag)
    }

    /// The pane exits: mark the flow cancelled and wake every prompt
    /// that is waiting for an answer the exited pane can no longer give.
    pub(crate) fn mark(&self) {
        self.flag.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = self.wake.send(true);
    }

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

/// The flow-side handle to the inline auth panel: one login run's request channel; the TUI run
/// loop owns the receiving side. A clone shares the run's channel and cancel signal.
#[derive(Clone)]
pub struct AuthPanelHandle {
    tx: mpsc::UnboundedSender<AuthPanelRequest>,
    /// The flow's cooperative cancel signal: the driving surface marks it when the panel or pane
    /// exits, and a blocking login body checks it before its auth-store writes — a
    /// `JoinHandle::abort` cannot reach a started `spawn_blocking` closure (#2770).
    cancel: FlowCancel,
}

impl AuthPanelHandle {
    /// Build the handle over one run's request channel (the session
    /// creates the pair; the loop owns the receiver).
    #[must_use]
    pub fn new(tx: mpsc::UnboundedSender<AuthPanelRequest>) -> Self {
        AuthPanelHandle {
            tx,
            cancel: FlowCancel::new(),
        }
    }

    #[must_use]
    pub fn cancelled(&self) -> bool {
        self.cancel.cancelled()
    }

    /// The flow's cancel signal for the driving side (the pane marks it on exit; clones share it).
    #[must_use]
    pub fn cancel_signal(&self) -> FlowCancel {
        self.cancel.clone()
    }

    /// The bare cancel flag (the #2790 codex login's shape) — loads observe every mark.
    #[must_use]
    pub fn cancel_flag(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        self.cancel.flag_arc()
    }

    /// Submit one request directly (the helpers below and the session's settled notes funnel here).
    pub fn send(&self, request: AuthPanelRequest) {
        let _ = self.tx.send(request);
    }

    /// The `onProgress` step chatter: the onboarding surface drops the line — the flow narrates
    /// itself there.
    pub fn progress(&self, message: impl Into<String>) {
        self.send(AuthPanelRequest::Progress {
            message: message.into(),
            chatter: true,
        });
    }

    /// A direct progress line: renders on every surface, onboarding included.
    pub fn progress_line(&self, message: impl Into<String>) {
        self.send(AuthPanelRequest::Progress {
            message: message.into(),
            chatter: false,
        });
    }

    /// The polling device flow's waiting line — the accent row above the actions row, rendered on
    /// every surface.
    pub fn waiting(&self, message: impl Into<String>) {
        self.send(AuthPanelRequest::Waiting {
            message: message.into(),
        });
    }

    pub fn auth_url(&self, url: &str, instructions: Option<&str>) {
        self.send(AuthPanelRequest::AuthUrl {
            url: url.to_string(),
            instructions: instructions.map(str::to_string),
        });
    }

    /// Prompt above the paste field; the submitted value resolves the future, a cancel answers
    /// `None`.
    pub async fn paste_prompt(
        &self,
        prompt: &str,
        tone: PastePromptTone,
        style: PasteStyle,
    ) -> Option<String> {
        self.paste_prompt_with(prompt, tone, style, false).await
    }

    /// The `allow_empty` variant: a blank submit resolves as an empty answer instead of the notice.
    pub async fn paste_prompt_allow_empty(
        &self,
        prompt: &str,
        tone: PastePromptTone,
        style: PasteStyle,
    ) -> Option<String> {
        self.paste_prompt_with(prompt, tone, style, true).await
    }

    async fn paste_prompt_with(
        &self,
        prompt: &str,
        tone: PastePromptTone,
        style: PasteStyle,
        allow_empty: bool,
    ) -> Option<String> {
        // An exited pane can never answer the prompt: a cancelled flow returns without sending.
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

    /// The team picker; a cancel answers `PrimeTeamPick::Cancelled` (the stored selection stays).
    pub async fn select_team(
        &self,
        teams: Vec<PrimeTeamOption>,
        current: Option<&str>,
    ) -> PrimeTeamPick {
        // An exited pane can never answer the picker: a cancelled flow returns the cancelled
        // pick.
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

    async fn cancelled_wait(&self) {
        self.cancel.wait().await;
    }
}

impl std::fmt::Debug for AuthPanelHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthPanelHandle").finish()
    }
}

const PREFERRED_VISIBLE_TEAMS: usize = 8;

const TOKEN_PLACEHOLDER: &str = "Paste token";

const TEAM_PANEL_TITLE: &str = "Select a Prime Team:";

const TEAM_PANEL_SUBTITLE: &str = "Choose which account pays for Prime Inference usage.";

const TEAM_SEARCH_PLACEHOLDER: &str = "Search teams";

/// The login dialog's paste field placeholder (the session's API-key prompt uses the same field).
pub(crate) const PASTE_PLACEHOLDER: &str = "Paste value";

const EMPTY_VALUE_NOTICE: &str = "The value cannot be empty.";

const BROWSER_DEFAULT_INSTRUCTIONS: &str = "Complete the sign-in in your browser.";

/// The outcome of copying the sign-in URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyStatus {
    Copied,
    Requested,
    Failed,
}

/// A single printable character types into the mounted paste field, so it stays the field's
/// while the field shows; every other bound key is the panel's.
fn is_printable_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if !c.is_control()) && chars.next().is_none()
}

/// The mounted panel: the flow's progress lines, the browser URL block, and the one active input
/// (a paste prompt or the team picker).
#[derive(Debug)]
pub struct AuthPanel {
    title: String,
    surface: PanelSurface,
    /// The panel subtitle; the team picker sets its own.
    subtitle: Option<String>,
    /// Progress lines, in arrival order.
    progress: Vec<String>,
    /// Whether the progress block opened the panel (the section title renders only while it was
    /// still empty).
    progress_open: bool,
    auth_url: Option<String>,
    auth_instructions: Option<String>,
    /// The empty-submit notice row (the token paste panel's arm only).
    notice: Option<String>,
    /// The waiting line — the accent row above the actions row.
    waiting: Option<String>,
    input: PanelInput,
    copy_status: Option<CopyStatus>,
    /// The flow's cooperative cancel signal: Esc/ctrl+c on a URL screen with no mounted input
    /// cancels the running login (the cancel hint is never a dead key).
    flow_cancel: Option<FlowCancel>,
}

#[derive(Debug)]
enum PanelInput {
    /// No input mounted: the flow works between requests (its progress lines stay; Esc has
    /// nothing to cancel — the flow settles within its request timeouts).
    Working,
    Paste {
        prompt: String,
        tone: PastePromptTone,
        style: PasteStyle,
        /// Whether a blank submit is a valid answer.
        allow_empty: bool,
        field: SearchInput,
        reply: Option<oneshot::Sender<Option<String>>>,
    },
    Teams {
        picker: PrimeTeamPicker,
        reply: Option<oneshot::Sender<PrimeTeamPick>>,
    },
}

impl AuthPanel {
    /// Mount the panel for one session-surface login run (the rule and the title open the panel).
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
            waiting: None,
            input: PanelInput::Working,
            copy_status: None,
            flow_cancel: None,
        }
    }

    /// Mount the panel inside the first-run onboarding block: the splash names the step, and the
    /// panel carries no chrome of its own (the title never renders here).
    pub fn onboarding(title: impl Into<String>) -> Self {
        let mut panel = AuthPanel::new(title);
        panel.surface = PanelSurface::Onboarding;
        panel
    }

    /// Arm the flow's cooperative cancel signal: the panel's cancel keys end a running login, not
    /// just a mounted input.
    pub fn set_cancel_signal(&mut self, cancel: FlowCancel) {
        self.flow_cancel = Some(cancel);
    }

    /// Whether the team picker owns the panel: its Esc answers the picker and keeps the dialog
    /// mounted (a session cancel unmounts every other state only).
    #[must_use]
    pub fn team_picker_mounted(&self) -> bool {
        matches!(self.input, PanelInput::Teams { .. })
    }

    /// The first line lands under the section title (rendered only while the panel was empty).
    pub fn push_progress(&mut self, message: &str) {
        if !self.content_open() {
            self.progress_open = true;
        }
        // The flow's lines can quote provider text: the same control-character hygiene every
        // daemon-supplied row carries.
        self.progress.push(scrub_controls(message));
    }

    /// The accent line replaces any earlier waiting status — one line, the flow's current state.
    pub fn push_waiting(&mut self, message: &str) {
        self.waiting = Some(scrub_controls(message));
    }

    /// Whether any content block has landed: the leading blank row renders once content ever
    /// ran, and the section title renders only before it.
    fn content_open(&self) -> bool {
        self.progress_open
            || self.waiting.is_some()
            || self.auth_url.is_some()
            || !matches!(self.input, PanelInput::Working)
    }

    /// The URL block replaces the content (the progress lines and paste field unmount with it)
    /// and the auth-actions row goes live.
    pub fn show_auth_url(&mut self, url: String, instructions: Option<String>) {
        self.auth_url = Some(url);
        self.auth_instructions = instructions;
        self.progress.clear();
        self.progress_open = false;
        self.copy_status = None;
        self.input = PanelInput::Working;
        self.notice = None;
        self.waiting = None;
    }

    /// The prompt above a fresh paste field (the flow's progress lines stay).
    pub fn mount_paste(
        &mut self,
        prompt: &str,
        tone: PastePromptTone,
        style: PasteStyle,
        allow_empty: bool,
        reply: oneshot::Sender<Option<String>>,
    ) {
        self.input = PanelInput::Paste {
            prompt: scrub_controls(prompt),
            tone,
            style,
            allow_empty,
            field: SearchInput::new(),
            reply: Some(reply),
        };
        self.notice = None;
        self.copy_status = None;
    }

    /// The picker mounts as its own panel (fresh title, subtitle, and rows; the login dialog's
    /// progress lines go with it).
    pub fn mount_teams(
        &mut self,
        teams: Vec<PrimeTeamOption>,
        current: Option<String>,
        reply: oneshot::Sender<PrimeTeamPick>,
    ) {
        self.title = TEAM_PANEL_TITLE.to_string();
        self.subtitle = Some(TEAM_PANEL_SUBTITLE.to_string());
        self.progress.clear();
        // The picker is its own panel: the dialog's whole content state goes with it — a stale
        // title or copy status must never bleed into the frame the pick leaves behind.
        self.progress_open = false;
        self.copy_status = None;
        self.auth_url = None;
        self.auth_instructions = None;
        self.copy_status = None;
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

    /// One key press while the panel owns the frame: the arms answer the mounted input through
    /// its oneshot; `sink` carries the copy's OSC 52 fallback.
    pub(crate) fn handle_key(
        &mut self,
        key: &str,
        kb: &KeybindingsManager,
        sink: &mut crate::clipboard::OscSink,
    ) {
        // A cancel key on a URL screen (no mounted input) ends the running login (the cancel hint
        // is never a dead key).
        if matches!(self.input, PanelInput::Working) && kb.matches(key, "tui.select.cancel") {
            self.mark_flow_cancelled();
            return;
        }
        // The copy binding copies the shown URL, except a single-character key while the paste
        // field is visible — that one types into the field (only non-text-entry keys copy then).
        if self.auth_url.is_some()
            && kb.matches(key, "app.clipboard.copyLoginUrl")
            && !(matches!(self.input, PanelInput::Paste { .. }) && is_printable_key(key))
        {
            self.copy_auth_url(sink);
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
                    // The paste's Esc must end the browser flow too, or a racing success writes
                    // credentials into an unmounted dialog (#2845 review).
                    self.mark_flow_cancelled();
                    answered = true;
                } else if kb.matches(key, "tui.select.confirm") {
                    let value = field.value().trim().to_string();
                    if value.is_empty() {
                        if *allow_empty {
                            // A blank submit is a valid answer (the Copilot domain prompt's
                            // "blank for github.com").
                            if let Some(reply) = reply.take() {
                                let _ = reply.send(Some(value));
                                answered = true;
                            }
                        } else if *style == PasteStyle::Masked {
                            // The token paste panel's empty-submit notice; the login dialog waits
                            // silently, so only the masked field shows it.
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

    /// Copy the shown URL and remember the outcome for the actions row. The payload carries
    /// exactly what the row renders, so a provider-supplied URL cannot ride the clipboard channel.
    fn copy_auth_url(&mut self, sink: &mut crate::clipboard::OscSink) {
        let Some(url) = self.auth_url.clone() else {
            return;
        };
        let url = scrub_controls(&url).replace('\n', "");
        self.copy_status = match crate::clipboard::copy_to_clipboard(&url, sink) {
            Ok(crate::clipboard::CopyOutcome::Confirmed) => Some(CopyStatus::Copied),
            Ok(crate::clipboard::CopyOutcome::Requested) => Some(CopyStatus::Requested),
            Err(_) => Some(CopyStatus::Failed),
        };
    }

    /// The payload lands in the mounted input — the paste field or the picker's search — never
    /// in the hidden editor behind the panel.
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

    /// Mark the driving flow's cancel signal: a running login ends between its poll steps; an
    /// unarmed signal is a flow that owns no cancel path.
    fn mark_flow_cancelled(&mut self) {
        if let Some(cancel) = &self.flow_cancel {
            cancel.mark();
        }
    }
}

#[cfg(test)]
mod tests;
