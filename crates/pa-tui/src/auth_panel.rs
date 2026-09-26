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

use tokio::sync::{mpsc, oneshot};

use crate::fuzzy::fuzzy_filter;
use crate::hyperlinks::{osc8_open, OSC8_CLOSE};
use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{
    hint_row, menu_row, no_match_row, scroll_row, scrub_controls, search_field_lines, MenuSegment,
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

/// One request a login flow (or its session wrapper) sends to the inline
/// auth panel. Fire-and-forget requests render; the prompt and picker
/// requests await their oneshot replies; the settled requests close the
/// panel and apply the outcome.
pub enum AuthPanelRequest {
    /// TS `dialog.showProgress`: a muted progress line joins the panel.
    Progress { message: String },
    /// TS `dialog.showAuth`: the browser URL block (the flow launches
    /// the browser itself; the panel only renders).
    AuthUrl {
        url: String,
        /// The provider instructions; `None` renders TS's default
        /// "Complete the sign-in in your browser." line.
        instructions: Option<String>,
    },
    /// TS `dialog.showManualInput` / `armManualInput`: the prompt above
    /// the panel's paste field. Enter submits the trimmed value (an
    /// empty submit stays mounted with the notice, unless the prompt
    /// allows it — TS `OAuthPrompt.allowEmpty`: a blank answer is a
    /// valid submit); Esc cancels the flow (`None`).
    PastePrompt {
        prompt: String,
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

    /// TS `dialog.showProgress`.
    pub fn progress(&self, message: impl Into<String>) {
        self.send(AuthPanelRequest::Progress {
            message: message.into(),
        });
    }

    /// TS `dialog.showAuth`.
    pub fn auth_url(&self, url: &str, instructions: Option<&str>) {
        self.send(AuthPanelRequest::AuthUrl {
            url: url.to_string(),
            instructions: instructions.map(str::to_string),
        });
    }

    /// TS `dialog.showManualInput` / `armManualInput`: prompt above the
    /// paste field; the submitted value resolves the future, a cancel
    /// answers `None`.
    pub async fn paste_prompt(&self, prompt: &str, style: PasteStyle) -> Option<String> {
        self.paste_prompt_with(prompt, style, false).await
    }

    /// The `allow_empty` variant (TS `OAuthPrompt.allowEmpty`): a blank
    /// submit resolves as an empty answer instead of the notice (the
    /// Copilot domain prompt's "blank for github.com").
    pub async fn paste_prompt_allow_empty(
        &self,
        prompt: &str,
        style: PasteStyle,
    ) -> Option<String> {
        self.paste_prompt_with(prompt, style, true).await
    }

    /// One paste prompt over the request channel (the two surfaces
    /// above funnel here).
    async fn paste_prompt_with(
        &self,
        prompt: &str,
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

/// The login dialog's paste field placeholder (TS
/// `MenuSearchInput("Paste value")`).
const PASTE_PLACEHOLDER: &str = "Paste value";

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

/// The empty-submit notice (TS `McpTokenPastePanelComponent`'s
/// "The value cannot be empty.").
const EMPTY_VALUE_NOTICE: &str = "The value cannot be empty.";

/// TS `LoginDialogComponent`'s default browser-step line.
const BROWSER_DEFAULT_INSTRUCTIONS: &str = "Complete the sign-in in your browser.";

/// The outcome of copying the sign-in URL (TS `getAuthActionsText`'s
/// status: `Copied sign-in link` / `Failed to copy sign-in link`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopyStatus {
    Copied,
    Failed,
}

/// TS `isPrintableInput` over a key id: a single printable character
/// types into the mounted paste field, so it stays the field's while the
/// field shows; every other bound key (a modified one like `alt+c`) is
/// the panel's.
fn is_printable_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if !c.is_control()) && chars.next().is_none()
}

/// The mounted panel: the flow's progress lines, the browser URL block,
/// and the one active input (a paste prompt or the team picker).
#[derive(Debug)]
pub struct AuthPanel {
    /// TS the dialog's panel title: `Login to {provider}` / `Connect
    /// {service}`.
    title: String,
    /// TS the `MenuPanel` subtitle; the team picker sets its own.
    subtitle: Option<String>,
    /// TS `showProgress` lines, in arrival order (the section title
    /// "Preparing authentication" rides first, TS `showProgress`'s
    /// empty-content arm).
    progress: Vec<String>,
    /// TS `showAuth`'s URL block.
    auth_url: Option<String>,
    auth_instructions: Option<String>,
    /// The URL block's copy outcome (TS the actions row's status text).
    copy_status: Option<CopyStatus>,
    /// The empty-submit notice row.
    notice: Option<String>,
    /// The active input.
    input: PanelInput,
}

/// The panel's active input.
#[derive(Debug)]
enum PanelInput {
    /// No input mounted: the flow works between requests (its progress
    /// lines stay; Esc has nothing to cancel — the flow settles within
    /// its request timeouts).
    Working,
    /// The paste prompt (TS `showManualInput`).
    Paste {
        prompt: String,
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
    /// Mount the panel for one login run: the title rides the top rule
    /// (TS `showAuthPanel` mounts the dialog the moment the flow starts).
    pub fn new(title: impl Into<String>) -> Self {
        AuthPanel {
            title: scrub_controls(&title.into()),
            subtitle: None,
            progress: Vec::new(),
            auth_url: None,
            auth_instructions: None,
            copy_status: None,
            notice: None,
            input: PanelInput::Working,
        }
    }

    /// TS `showProgress`: the first line lands under the section title.
    /// One request-fold entry (the session's channel arm calls it).
    pub fn push_progress(&mut self, message: String) {
        if self.progress.is_empty() {
            self.progress.push("Preparing authentication".to_string());
        }
        // The flow's lines can quote provider text: the same control
        // character hygiene every daemon-supplied row carries.
        self.progress.push(scrub_controls(&message));
    }

    /// TS `showAuth`: the URL block replaces the content (the paste
    /// field unmounts with it, TS `startContent` clears). One
    /// request-fold entry (the session's channel arm calls it).
    pub fn show_auth_url(&mut self, url: String, instructions: Option<String>) {
        self.auth_url = Some(url);
        self.auth_instructions = instructions;
        self.copy_status = None;
        self.input = PanelInput::Working;
        self.notice = None;
    }

    /// TS `showManualInput` / `armManualInput`: the prompt above a fresh
    /// paste field (the flow's progress lines stay). One request-fold
    /// entry (the session's channel arm calls it).
    pub fn mount_paste(
        &mut self,
        prompt: String,
        style: PasteStyle,
        allow_empty: bool,
        reply: oneshot::Sender<Option<String>>,
    ) {
        self.input = PanelInput::Paste {
            prompt: scrub_controls(&prompt),
            style,
            allow_empty,
            field: SearchInput::new(),
            reply: Some(reply),
        };
        self.notice = None;
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

    /// One key press while the panel owns the frame (TS
    /// `LoginDialogComponent.handleInput` /
    /// `PrimeTeamSelectorComponent.handleInput`). The arms answer the
    /// mounted input through its oneshot; the answered flag hands the
    /// panel back to the flow after the match (the arms never hold the
    /// input's reply past its last use).
    ///
    /// `sink` carries the copy's OSC 52 fallback: stdout on the terminal,
    /// the session's captured buffer in a headless run.
    pub(crate) fn handle_key(
        &mut self,
        key: &str,
        kb: &KeybindingsManager,
        sink: &mut crate::clipboard::OscSink,
    ) {
        // Ctrl+C cancels the mounted input like Esc (the surfaces that
        // consume the pair note it handled).
        if key == "ctrl+c" {
            self.cancel_input();
            return;
        }
        // TS `handleInput`'s copy arm: the copy binding copies the shown
        // URL, except a single-character key while the paste field is
        // visible — that one types into the field, so only the binding's
        // non-text-entry keys (TS's `alt+c` default) copy then.
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
                        } else {
                            // TS the paste panel's empty-submit notice; the
                            // field stays mounted.
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

    /// TS `copyAuthUrl`: copy the shown URL through the platform
    /// clipboard chain and remember the outcome for the actions row (the
    /// status text replaces the hint until the next URL replaces both).
    fn copy_auth_url(&mut self, sink: &mut crate::clipboard::OscSink) {
        let Some(url) = self.auth_url.clone() else {
            return;
        };
        self.copy_status = match crate::clipboard::copy_to_clipboard(&url, sink) {
            Ok(()) => Some(CopyStatus::Copied),
            Err(_) => Some(CopyStatus::Failed),
        };
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
    /// selection stays, TS `onCancel`); no input means nothing to
    /// cancel.
    fn cancel_input(&mut self) {
        match &mut self.input {
            PanelInput::Working => {}
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

    /// The panel's rendered rows (the provider selector's panel chrome:
    /// the top rule, the title, the subtitle, the content, the hint, the
    /// bottom rule).
    pub(crate) fn render(
        &mut self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
    ) -> Vec<Line> {
        let mut lines: Vec<Line> = Vec::new();
        lines.push(Vec::new());
        lines.push(vec![
            theme.fg_span(ThemeColor::Border, "\u{2500}".repeat(width.max(1)))
        ]);
        lines.push(vec![crate::Span::raw(format!("  {}", self.title))]);
        if let Some(subtitle) = &self.subtitle {
            lines.push(vec![
                theme.fg_span(ThemeColor::Muted, format!("  {subtitle}"))
            ]);
        }
        lines.push(Vec::new());
        for message in &self.progress {
            lines.push(vec![
                theme.fg_span(ThemeColor::Muted, format!("  {message}"))
            ]);
        }
        if let Some(url) = &self.auth_url {
            // The URL and the instructions are provider-supplied: control
            // characters can never execute terminal control operations
            // when rendered (the same hygiene every daemon-supplied row
            // carries); a URL is additionally single-line, so newlines
            // drop. TS `showAuth` wraps the URL in OSC 8 (the URL is the
            // link's own display text) when the terminal is known to
            // implement hyperlinks, else prints it plain.
            let safe = scrub_controls(url).replace('\n', "");
            let linked = if crate::hyperlinks::hyperlinks_enabled() {
                format!("{}{safe}{OSC8_CLOSE}", osc8_open(&safe))
            } else {
                safe
            };
            lines.push(vec![
                theme.fg_span(ThemeColor::Accent, format!("  {linked}"))
            ]);
            let instructions = self.auth_instructions.clone().map_or_else(
                || BROWSER_DEFAULT_INSTRUCTIONS.to_string(),
                |text| scrub_controls(&text),
            );
            lines.push(vec![
                theme.fg_span(ThemeColor::Text, format!("  {instructions}"))
            ]);
        }
        match &mut self.input {
            PanelInput::Working => {}
            PanelInput::Paste {
                prompt,
                style,
                field,
                ..
            } => {
                lines.push(vec![theme.fg_span(ThemeColor::Muted, format!("  {prompt}"))]);
                let placeholder = match style {
                    PasteStyle::Visible => PASTE_PLACEHOLDER,
                    PasteStyle::Masked => TOKEN_PLACEHOLDER,
                };
                let (value, cursor) = match style {
                    // A masked render never contains the secret: only the
                    // bullet projection rides the line (TS
                    // `McpTokenPastePanelComponent`).
                    PasteStyle::Masked => (
                        "\u{2022}".repeat(field.value().chars().count()),
                        field.value().chars().count(),
                    ),
                    PasteStyle::Visible => (field.value().to_string(), field.cursor()),
                };
                lines.append(&mut search_field_lines(
                    theme,
                    width,
                    &value,
                    cursor,
                    true,
                    placeholder,
                ));
                if let Some(notice) = &self.notice {
                    lines.push(vec![
                        theme.fg_span(ThemeColor::Warning, format!("  {notice}"))
                    ]);
                }
                // While the URL block shows, the actions row below the
                // input carries the submit and cancel hints (TS
                // `getAuthActionsText`); a paste-only panel (the MCP token
                // surface) keeps its own hint row.
                if self.auth_url.is_none() {
                    lines.push(hint_row(theme, width, "enter submit  escape cancel"));
                }
            }
            PanelInput::Teams { picker, .. } => {
                let mut search = search_field_lines(
                    theme,
                    width,
                    picker.search.value(),
                    picker.search.cursor(),
                    false,
                    TEAM_SEARCH_PLACEHOLDER,
                );
                lines.append(&mut search);
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
                lines.push(hint_row(
                    theme,
                    width,
                    "\u{2191}\u{2193} navigate  enter select  escape cancel",
                ));
            }
        }
        // TS `getAuthActionsText`: the URL block's actions row rides last —
        // the copy-key hint with the status of the last copy, the submit
        // hint while the paste field is mounted, and the cancel hint.
        if self.auth_url.is_some() {
            lines.push(self.auth_actions_row(theme, width, kb));
        }
        lines.push(vec![
            theme.fg_span(ThemeColor::Border, "\u{2500}".repeat(width.max(1)))
        ]);
        lines
    }

    /// TS `getAuthActionsText` as one row: the submit hint while the paste
    /// field is mounted, the copy status, the copy-key hint (the panel's
    /// non-text-entry keys while the field shows — a plain key types into
    /// it — else the first bound key, so the primary plain key is what the
    /// user sees), and the cancel hint, joined by the TS two-space
    /// separator. A failed copy renames the hint's action to `retry`. The
    /// cancel hint rides only while a cancellable input is mounted: with
    /// no input (the URL block alone), Esc has nothing to cancel — the
    /// flow settles through its own timeout — and a hint that does
    /// nothing is worse than none.
    fn auth_actions_row(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Line {
        let field_visible = matches!(self.input, PanelInput::Paste { .. });
        let mut parts: Vec<Line> = Vec::new();
        if field_visible {
            if let Some(key) = kb.first_key("tui.select.confirm") {
                parts.push(hint_part(theme, &key, "submit"));
            }
        }
        match self.copy_status {
            Some(CopyStatus::Copied) => {
                parts.push(vec![
                    theme.fg_span(ThemeColor::Success, "Copied sign-in link".to_string())
                ]);
            }
            Some(CopyStatus::Failed) => {
                parts.push(vec![theme.fg_span(
                    ThemeColor::Error,
                    "Failed to copy sign-in link".to_string(),
                )]);
            }
            None => {}
        }
        let keys = kb.get_keys("app.clipboard.copyLoginUrl");
        let keys: Vec<String> = if field_visible {
            keys.into_iter()
                .filter(|key| !is_text_entry_keybinding(key))
                .collect()
        } else {
            keys.into_iter().take(1).collect()
        };
        if !keys.is_empty() {
            let action = if self.copy_status == Some(CopyStatus::Failed) {
                "retry"
            } else {
                "copy"
            };
            parts.push(vec![
                theme.fg_span(ThemeColor::Dim, format_key_text(&keys.join("/"))),
                theme.fg_span(ThemeColor::Muted, format!(" {action}")),
            ]);
        }
        if matches!(self.input, PanelInput::Paste { .. } | PanelInput::Teams { .. }) {
            parts.extend(
                kb.first_key("tui.select.cancel")
                    .map(|key| hint_part(theme, &key, "cancel")),
            );
        }
        let mut spans: Vec<Span> = vec![Span::raw("  ")];
        for (index, part) in parts.into_iter().enumerate() {
            if index > 0 {
                spans.push(Span::raw("  "));
            }
            spans.extend(part);
        }
        crate::width::truncate_line(&spans, width, "")
    }
}

/// One hint part (TS `keyHint`): the key label dim, the action muted.
fn hint_part(theme: &Theme, key: &str, action: &str) -> Line {
    vec![
        theme.fg_span(ThemeColor::Dim, format_key_text(key)),
        theme.fg_span(ThemeColor::Muted, format!(" {action}")),
    ]
}

/// TS `isTextEntryKeybinding` over one bound key id: a binding whose
/// final part is a single character (or `space`) with no ctrl/alt
/// modifier is the field's text while the paste field shows.
fn is_text_entry_keybinding(key: &str) -> bool {
    let parts: Vec<&str> = key.split('+').collect();
    let key_part = parts.last().copied().unwrap_or("");
    !parts.iter().any(|part| *part == "ctrl" || *part == "alt")
        && (key_part == "space" || key_part.chars().count() == 1)
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

    /// The copy path's captured OSC 52 channel (a headless run's sink).
    fn sink() -> crate::clipboard::OscSink {
        crate::clipboard::OscSink::Buffer(Vec::new())
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
            .render(&theme(), 90, &kb())
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect()
    }

    /// A paste prompt mounted over a panel with its oneshot pair.
    fn mount_paste() -> (AuthPanel, oneshot::Receiver<Option<String>>) {
        let mut panel = AuthPanel::new("Login to Prime Inference");
        let (reply, answer) = oneshot::channel();
        panel.mount_paste(
            "Paste a Prime API key below:".to_string(),
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

    /// The paste prompt renders the TS prompt row, the bordered field
    /// with the "Paste value" placeholder, and the hint row; Enter
    /// submits the trimmed value through the oneshot.
    #[test]
    fn the_paste_prompt_submits_the_typed_value() {
        let (mut panel, mut answer) = mount_paste();
        // The mounted field shows its placeholder while empty, the prompt
        // row above it, and the hint row below.
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("Paste a Prime API key below:")));
        assert!(rows.iter().any(|row| row.contains("Paste value")));
        assert!(rows.iter().any(|row| row.contains("enter submit")));
        for character in "  sk-live  ".chars() {
            panel.handle_key(character.to_string().as_str(), &kb(), &mut sink());
        }
        panel.handle_key("enter", &kb(), &mut sink());
        assert_eq!(answer.try_recv(), Ok(Some("sk-live".to_string())));
    }

    /// Esc on the paste prompt cancels the flow (`None`), TS the dialog
    /// cancel.
    #[test]
    fn escape_on_the_paste_prompt_cancels_the_flow() {
        let (mut panel, mut answer) = mount_paste();
        panel.handle_key("escape", &kb(), &mut sink());
        assert_eq!(answer.try_recv(), Ok(None));
    }

    /// TS the token paste panel: an empty submit keeps the field mounted
    /// and shows the notice; the submit that follows still works.
    #[test]
    fn an_empty_paste_submit_shows_the_notice() {
        let (mut panel, mut answer) = mount_paste();
        panel.handle_key("enter", &kb(), &mut sink());
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("The value cannot be empty.")));
        assert!(answer.try_recv().is_err(), "nothing answered");
        panel.handle_key("k", &kb(), &mut sink());
        panel.handle_key("enter", &kb(), &mut sink());
        assert_eq!(answer.try_recv(), Ok(Some("k".to_string())));
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
            PasteStyle::Visible,
            true,
            reply,
        );
        panel.handle_key("enter", &kb(), &mut sink());
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
            PasteStyle::Masked,
            false,
            oneshot::channel().0,
        );
        for character in "ghp_secretvalue".chars() {
            panel.handle_key(character.to_string().as_str(), &kb(), &mut sink());
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
        panel.handle_key("down", &kb(), &mut sink());
        panel.handle_key("enter", &kb(), &mut sink());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Team(acme())));
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_key("enter", &kb(), &mut sink());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::PersonalAccount));
    }

    /// TS `onCancel`: Esc answers the cancelled pick (the stored
    /// selection stays; the flow resolves the default status).
    #[test]
    fn escape_on_the_picker_answers_the_cancelled_pick() {
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_key("escape", &kb(), &mut sink());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Cancelled));
    }

    /// TS `filterOptions`: the search filters over the personal row's and
    /// the teams' search text (name, slug, role, id); Enter on the
    /// surviving row picks it.
    #[test]
    fn the_picker_search_filters_and_picks_the_surviving_row() {
        let (mut panel, mut answer) = mount_teams(vec![acme(), beta()], None);
        for character in "acme".chars() {
            panel.handle_key(character.to_string().as_str(), &kb(), &mut sink());
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
        panel.handle_key("enter", &kb(), &mut sink());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Team(acme())));
        // The personal row's search text matches "personal account".
        let (mut panel, _answer) = mount_teams(vec![acme()], None);
        for character in "personal".chars() {
            panel.handle_key(character.to_string().as_str(), &kb(), &mut sink());
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
            panel.handle_key(character.to_string().as_str(), &kb(), &mut sink());
        }
        let rows = frame_text(&mut panel);
        assert!(rows.iter().any(|row| row.contains("No matching teams")));
        panel.handle_key("enter", &kb(), &mut sink());
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
        panel.handle_key("up", &kb(), &mut sink());
        panel.handle_key("enter", &kb(), &mut sink());
        assert_eq!(
            answer.try_recv(),
            Ok(PrimeTeamPick::PersonalAccount),
            "up clamps at the personal row (index 0)"
        );
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_key("down", &kb(), &mut sink());
        panel.handle_key("down", &kb(), &mut sink());
        panel.handle_key("enter", &kb(), &mut sink());
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
                .paste_prompt("Paste a key:", PasteStyle::Visible)
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
        panel.handle_key("enter", &kb(), &mut sink());
        assert_eq!(answer.try_recv(), Ok(Some("sk-pasted-key".to_string())));
        // The picker's search accepts pasted text too (TS `MenuSearchInput`).
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_paste("acme");
        panel.handle_key("enter", &kb(), &mut sink());
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

    /// On a hyperlink terminal the URL block wraps its URL in the OSC 8
    /// open/close pair (TS `showAuth`'s `linkedUrl`), so the row is a
    /// clickable link AND carries the URL as its own display text.
    #[test]
    fn the_url_block_wraps_the_osc8_pair_when_hyperlinks_supported() {
        crate::hyperlinks::set_hyperlinks_override(Some(true));
        let mut panel = AuthPanel::new("Login to Linear");
        panel.show_auth_url("https://fixture.example/authorize".to_string(), None);
        let rows = frame_text(&mut panel);
        crate::hyperlinks::set_hyperlinks_override(None);
        let linked = rows
            .iter()
            .find(|row| row.contains("https://fixture.example/authorize"))
            .expect("the URL row");
        assert_eq!(
            *linked,
            format!(
                "  {}https://fixture.example/authorize{}",
                crate::hyperlinks::osc8_open("https://fixture.example/authorize"),
                crate::hyperlinks::OSC8_CLOSE
            ),
            "the row is the indented OSC 8 pair around the bare URL"
        );
    }

    /// The copy binding is the TS default pair: a PLAIN key (`c`) with the
    /// `alt+c` fallback — no Option/Alt modifier required to copy the
    /// login URL (the operator directive, TS
    /// `app.clipboard.copyLoginUrl`).
    #[test]
    fn the_copy_binding_defaults_to_a_plain_key() {
        assert_eq!(
            kb().get_keys("app.clipboard.copyLoginUrl"),
            vec!["c".to_string(), "alt+c".to_string()]
        );
    }

    /// TS `copyAuthUrl` + `getAuthActionsText`: the copy key copies the
    /// shown URL through the clipboard chain, and the actions row reports
    /// the success status beside its hints. With no input mounted (the
    /// URL block alone) the cancel hint stays off — Esc has nothing to
    /// cancel while the flow settles through its own timeout.
    #[test]
    fn the_copy_key_copies_the_url_and_reports_the_status() {
        let mut panel = AuthPanel::new("Login to Prime Inference");
        panel.show_auth_url("https://fixture.example/auth".to_string(), None);
        panel.handle_key("c", &kb(), &mut sink());
        let rows = frame_text(&mut panel);
        let actions = rows
            .iter()
            .find(|row| row.contains("Copied sign-in link"))
            .expect("the success status rendered");
        assert!(
            actions.contains("C copy"),
            "the plain-key hint rides the actions row: {actions:?}"
        );
        assert!(
            !actions.contains("Esc cancel"),
            "no cancellable input is mounted: {actions:?}"
        );
    }

    /// TS `handleInput`'s `inputVisible` guard: while the paste field
    /// shows, a plain character types into the field — the hint drops it
    /// for the non-text-entry `Alt+C` — and that fallback key still
    /// copies the URL.
    #[test]
    fn a_plain_key_types_into_the_field_but_alt_c_copies() {
        // The URL block shows first (TS `showAuth`), then the flow mounts
        // the paste field beside it (`showManualInput` over the URL).
        let mut panel = AuthPanel::new("Login to Prime Inference");
        panel.show_auth_url("https://fixture.example/auth".to_string(), None);
        let (reply, _answer) = oneshot::channel();
        panel.mount_paste(
            "Paste the code:".to_string(),
            PasteStyle::Visible,
            false,
            reply,
        );
        panel.handle_key("c", &kb(), &mut sink());
        let rows = frame_text(&mut panel);
        assert!(
            !rows.iter().any(|row| row.contains("Copied sign-in link")),
            "the plain key did not copy: {rows:?}"
        );
        assert!(
            rows.iter()
                .any(|row| row.contains("Alt+C copy") && row.contains("Enter submit")),
            "the field-visible hint filters the plain key and adds submit: {rows:?}"
        );
        panel.handle_key("alt+c", &kb(), &mut sink());
        assert!(
            frame_text(&mut panel)
                .iter()
                .any(|row| row.contains("Copied sign-in link")),
            "the alt-bound key copied the URL"
        );
    }
}
